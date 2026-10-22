# Convert AssetRipper-exported scenario effect prefabs into compact JSON for the
# web player's particle runtime (src/scenario/particles.ts).
#   FX_RAW_DIR=<raw scenario/effect bundles> python3 -I fx_convert.py <export Assets dir> <out dir> [name ...]
#   ... fx_convert.py <Assets> <out> --prefab=<file.prefab> --name=<out name> [--unit=<ref px per unit>]
# Inputs: an AssetRipper "Unity project" export of the scenario/effect (or
# scenario/background) bundles together with the shader/*.bundle files, and
# the raw bundles themselves (MonoBehaviours such as UI Image are read from
# them with UnityPy, since the export has no game assemblies). UnityPy and
# lz4 must be importable (UNITYPY_PATH adds a directory to sys.path).
# Output: <out>/<effect>/effect.json + the textures it references.
#
# Unity field names are kept; only these are compacted:
#   MinMaxCurve    → {"m": state, "s": scalar, "n": minScalar, "c": curve, "cn": minCurve}
#   AnimationCurve → [[time, value, inSlope, outSlope], ...] (+ pre/post wrap as "w")
#   Gradient       → {"c": [[t, r, g, b]...], "a": [[t, a]...], "f": fixedMode}
#   MinMaxGradient → {"m": state, "max": rgba, "min": rgba, "g": grad, "gn": grad}
import glob, json, os, re, shutil, sys, zlib
import yaml

if os.environ.get("UNITYPY_PATH"):
    sys.path.insert(0, os.environ["UNITYPY_PATH"])
import UnityPy  # noqa: E402

UnityPy.config.FALLBACK_UNITY_VERSION = "2022.3.62f2"
RAW_DIR = os.environ.get("FX_RAW_DIR", "")

ASSETS, OUT = sys.argv[1], sys.argv[2]
ONLY = set(a for a in sys.argv[3:] if "=" not in a)
# --prefab=<path> --name=<out name> --unit=<ref px per world unit> converts one
# prefab outside the effect bundles (e.g. the APK's SEKAI transition prefabs)
OPTS = dict(a[2:].split("=", 1) for a in sys.argv[3:] if a.startswith("--"))
EFFECT_DIR = os.path.join(ASSETS, "sekai/assetbundle/resources/ondemand/scenario/effect")

# Unity class ids we read
GAMEOBJECT, TRANSFORM, RECT, PS, PSR, SPRITE_R, MESH_R, MESH_F, ANIMATOR, CANVAS, CANVAS_R, MONO, SPRITE_MASK = (
    1, 4, 224, 198, 199, 212, 23, 33, 95, 223, 222, 114, 331)
DROP_MODULES = {"CollisionModule", "TriggerModule", "LightsModule", "ExternalForcesModule",
                "InheritVelocityModule", "LifetimeByEmitterSpeedModule"}
KEEP_ALWAYS = {"InitialModule", "ShapeModule", "EmissionModule"}

# ---------------------------------------------------------------- yaml loading
_guid_index = None


def guid_index():
    """guid → asset path for every .meta under ASSETS."""
    global _guid_index
    if _guid_index is None:
        _guid_index = {}
        for m in glob.glob(os.path.join(ASSETS, "**/*.meta"), recursive=True):
            with open(m, errors="ignore") as f:
                g = re.search(r"guid: (\w+)", f.read(400))
            if g:
                _guid_index[g.group(1)] = m[:-5]
    return _guid_index


def load_docs(path):
    """{fileID: (classID, body dict)} for a Unity YAML file."""
    src = open(path, errors="ignore").read()
    docs = {}
    for m in re.finditer(r"--- !u!(\d+) &(-?\d+)[^\n]*\n(.*?)(?=\n--- !u!|\Z)", src, re.S):
        body = yaml.safe_load(re.sub(r"!u!\d+", "", m.group(3)))
        if isinstance(body, dict) and len(body) == 1:
            body = next(iter(body.values()))
        docs[m.group(2)] = (int(m.group(1)), body)
    return docs


def ref(r):
    """PPtr → ('local', fileID) | ('asset', guid, fileID) | None"""
    if not isinstance(r, dict) or not r.get("fileID"):
        return None
    if r.get("guid"):
        return ("asset", r["guid"], str(r["fileID"]))
    return ("local", str(r["fileID"]))


# ---------------------------------------------------------------- compaction
def curve(c):
    if not isinstance(c, dict) or "m_Curve" not in c:
        return None
    keys = [[round(_slope(k["time"]), 5), round(_slope(k["value"]), 5), round(_slope(k.get("inSlope")), 5), round(_slope(k.get("outSlope")), 5)]
            for k in (c.get("m_Curve") or [])]
    out = {"k": keys}
    if c.get("m_PreInfinity", 2) != 2 or c.get("m_PostInfinity", 2) != 2:
        out["w"] = [c.get("m_PreInfinity", 2), c.get("m_PostInfinity", 2)]
    return out


def _slope(v):
    if v is None:
        return 0.0
    if isinstance(v, str):  # "Infinity" for stepped keys
        return 1e9 if "Inf" in v and "-" not in v else -1e9
    return float(v)


def rgba(c):
    return [round(_slope(c.get("r", 0)), 4), round(_slope(c.get("g", 0)), 4), round(_slope(c.get("b", 0)), 4), round(_slope(c.get("a", 1)), 4)]


def gradient(g):
    if not isinstance(g, dict) or "key0" not in g:
        return None
    nc, na = g.get("m_NumColorKeys", 2), g.get("m_NumAlphaKeys", 2)
    cols = [[round(g[f"ctime{i}"] / 65535, 4)] + rgba(g[f"key{i}"])[:3] for i in range(nc)]
    alps = [[round(g[f"atime{i}"] / 65535, 4), round(g[f"key{i}"]["a"], 4)] for i in range(na)]
    return {"c": cols, "a": alps, "f": g.get("m_Mode", 0)}


def compact(v):
    """Recursively replace Unity curve/gradient structs with compact forms."""
    if isinstance(v, dict):
        if "minMaxState" in v and "scalar" in v:
            o = {"m": v["minMaxState"], "s": v.get("scalar", 0), "n": v.get("minScalar", 0)}
            if v["minMaxState"] in (1, 2):
                o["c"] = curve(v.get("maxCurve"))
            if v["minMaxState"] == 2:
                o["cn"] = curve(v.get("minCurve"))
            return o
        if "minMaxState" in v and ("maxGradient" in v or "maxColor" in v):
            st = v["minMaxState"]
            o = {"m": st}
            if st in (0, 2):
                o["max"] = rgba(v.get("maxColor", {}))
            if st == 2:
                o["min"] = rgba(v.get("minColor", {}))
            if st in (1, 3, 4):
                o["g"] = gradient(v.get("maxGradient"))
            if st == 3:
                o["gn"] = gradient(v.get("minGradient"))
            return o
        if "key0" in v and "ctime0" in v:
            return gradient(v)
        if "m_Curve" in v and "m_PreInfinity" in v:
            return curve(v)
        return {k: compact(x) for k, x in v.items()
                if not k.startswith("m_Corresponding") and not k.startswith("m_Prefab") and not k.endswith("Label0_0")}
    if isinstance(v, list):
        return [compact(x) for x in v]
    return v


def particle_system(ps):
    out = {}
    for k, v in ps.items():
        if k in DROP_MODULES or k.startswith("m_") or k == "serializedVersion":
            continue
        if k.endswith("Module") and isinstance(v, dict):
            if not v.get("enabled") and k not in KEEP_ALWAYS:
                continue
            v = {kk: vv for kk, vv in v.items() if not kk.startswith("vectorLabel") and not kk.startswith("colorLabel")}
        out[k] = compact(v)
    sub = ps.get("SubModule") or {}
    if sub.get("enabled"):
        out["SubModule"] = {"subEmitters": [{"emitter": (ref(e.get("emitter")) or [None, None])[-1],
                                             "type": e.get("type"), "properties": e.get("properties"),
                                             "emitProbability": e.get("emitProbability", 1)}
                                            for e in sub.get("subEmitters") or []]}
    return out


# ---------------------------------------------------------------- assets
class Effect:
    def __init__(self, name):
        self.name = name
        self.dir = os.path.join(OUT, name)
        self.textures = {}  # src path → file name in out dir
        self.materials = {}  # guid → material json
        self.meshes = {}
        self.sprites = {}
        self.clips = {}

    def texture(self, r):
        rr = ref(r)
        if not rr or rr[0] != "asset":
            return None
        src = guid_index().get(rr[1])
        if not src:
            return None
        if src.endswith(".asset"):  # Texture2D stored as .asset next to an image
            for ext in (".png", ".jpg"):
                if os.path.exists(src[:-6] + ext):
                    src = src[:-6] + ext
                    break
        if not os.path.exists(src) or not src.lower().endswith((".png", ".jpg")):
            return None
        if src not in self.textures:
            base = re.sub(r"[^\w.-]", "_", os.path.basename(src))
            while base in self.textures.values():
                base = "_" + base
            self.textures[src] = base
        return self.textures[src]

    def material(self, r):
        rr = ref(r)
        if not rr or rr[0] != "asset":
            return None
        g = rr[1]
        if g in self.materials:
            return g
        path = guid_index().get(g)
        if not path or not path.endswith(".mat"):
            self.materials[g] = {"shader": None}
            return g
        _, m = next(iter(load_docs(path).values()))
        sh = ref(m.get("m_Shader"))
        shader_name = None
        # Unity built-in extra resources (legacy mobile particle shaders)
        BUILTIN = {"10720": "Mobile/Particles/Additive", "10721": "Mobile/Particles/Alpha Blended",
                   "10722": "Mobile/Particles/Multiply", "10723": "Mobile/Particles/VertexLit Blended"}
        if sh and sh[0] == "asset" and sh[1] == "0000000000000000f000000000000000":
            shader_name = BUILTIN.get(sh[2])
        elif sh and sh[0] == "asset":
            sp = guid_index().get(sh[1])
            if sp and sp.endswith(".shader"):
                with open(sp, errors="ignore") as f:
                    mm = re.search(r'Shader "([^"]+)"', f.read(300))
                shader_name = mm.group(1) if mm else os.path.basename(sp)
        props = m.get("m_SavedProperties", {})

        def entries(x):  # mapping, or a list of one-key mappings
            if isinstance(x, dict):
                return list(x.items())
            return [kv for e in x or [] for kv in e.items()]
        tex = {}
        for k, v in entries(props.get("m_TexEnvs")):
            if True:
                t = self.texture(v.get("m_Texture"))
                if t:
                    tex[k] = {"file": t, "st": [v["m_Scale"]["x"], v["m_Scale"]["y"], v["m_Offset"]["x"], v["m_Offset"]["y"]]}
        floats = dict(entries(props.get("m_Floats")))
        colors = {k: rgba(v) for k, v in entries(props.get("m_Colors"))}
        self.materials[g] = {"name": m.get("m_Name"), "shader": shader_name, "tex": tex,
                             "floats": {k: v for k, v in floats.items() if k in ("_Mode", "_Blend", "_SrcBlend", "_DstBlend", "_Cutoff", "_InvFade", "_Intensity")},
                             "colors": colors, "queue": m.get("m_CustomRenderQueue")}
        return g

    def sprite(self, r):
        rr = ref(r)
        if not rr or rr[0] != "asset":
            return None
        key = rr[1] + ":" + rr[2]
        if key in self.sprites:
            return key
        path = guid_index().get(rr[1])
        if not path:
            return None
        docs = load_docs(path)
        sp = docs.get(rr[2]) or next(iter(docs.values()))
        _, s = sp
        rd = s.get("m_RD", {})
        tr = rd.get("textureRect") or s.get("m_Rect")
        self.sprites[key] = {"tex": self.texture(rd.get("texture")), "rect": [tr["x"], tr["y"], tr["width"], tr["height"]],
                             "pivot": [s["m_Pivot"]["x"], s["m_Pivot"]["y"]], "ppu": s.get("m_PixelsToUnits", 100),
                             "border": [s["m_Border"][k] for k in "xyzw"] if s.get("m_Border") else None}
        return key

    def mesh(self, r):
        """Mesh → {verts: [[x,y,z]...], uvs: [[u,v]...], tris: [...]} when stored readable in YAML."""
        rr = ref(r)
        if not rr:
            return None
        if rr[0] == "asset" and rr[1] == "0000000000000000e000000000000000":
            return {"builtin": int(rr[2])}  # 10202 Cube, 10207 Sphere, 10209 Plane, 10210 Quad ...
        key = ":".join(rr[1:])
        if key in self.meshes:
            return key
        path = guid_index().get(rr[1]) if rr[0] == "asset" else None
        if not path:
            return None
        docs = load_docs(path)
        _, m = docs.get(rr[2]) or next(iter(docs.values()))
        self.meshes[key] = decode_mesh(m)
        return key

    def clip(self, r):
        rr = ref(r)
        if not rr or rr[0] != "asset":
            return None
        g = rr[1]
        if g in self.clips:
            return g
        path = guid_index().get(g)
        if not path or not path.endswith(".anim"):
            return None
        _, c = next(iter(load_docs(path).values()))
        st = c.get("m_AnimationClipSettings", {})
        out = {"name": c.get("m_Name"), "len": st.get("m_StopTime", 0), "loop": st.get("m_LoopTime", 0),
               "wrap": c.get("m_WrapMode", 0), "curves": []}
        for kind in ("m_PositionCurves", "m_ScaleCurves", "m_EulerCurves"):
            for cv in c.get(kind) or []:
                keys = [[k["time"], [k["value"]["x"], k["value"]["y"], k["value"]["z"]],
                         [_slope(k["inSlope"][a]) for a in "xyz"], [_slope(k["outSlope"][a]) for a in "xyz"]]
                        for k in cv["curve"]["m_Curve"]]
                out["curves"].append({"path": cv.get("path") or "", "kind": kind[2:-6].lower(), "keys": keys})
        for cv in c.get("m_FloatCurves") or []:
            out["curves"].append({"path": cv.get("path") or "", "kind": "float", "attr": cv.get("attribute"),
                                  "cls": cv.get("classID"), "curve": curve(cv.get("curve"))})
        for cv in c.get("m_PPtrCurves") or []:
            out["curves"].append({"path": cv.get("path") or "", "kind": "pptr", "attr": cv.get("attribute"), "cls": cv.get("classID"),
                                  "keys": [[k["time"], self.sprite(k.get("value")) if cv.get("classID") == 212 else None]
                                           for k in cv.get("curve") or []]})
        events = [{"t": e.get("time"), "fn": e.get("functionName"), "s": e.get("data")} for e in c.get("m_Events") or []]
        if events:
            out["events"] = events
        self.clips[g] = out
        return g


def decode_mesh(m):
    """Read vertex positions/uv0 and indices from AssetRipper's YAML mesh."""
    try:
        vd = m["m_VertexData"]
        n = vd["m_VertexCount"]
        data = bytes.fromhex(vd["_typelessdata"])
        chans = vd["m_Channels"]
        # stream 0 only; compute offsets
        fmt_size = {0: 4, 1: 2, 2: 1, 3: 1, 4: 2, 5: 2, 6: 1, 7: 1, 8: 2, 9: 2, 10: 4, 11: 4}
        stride = sum(c["dimension"] * fmt_size.get(c["format"], 4) for c in chans if c["stream"] == 0 and c["dimension"])
        import struct

        def read(ci):
            c = chans[ci]
            if not c["dimension"] or c["stream"] != 0 or c["format"] != 0:
                return None
            return [list(struct.unpack_from("<" + "f" * c["dimension"], data, i * stride + c["offset"])) for i in range(n)]
        verts, uvs = read(0), read(4)
        ib = bytes.fromhex(m["m_IndexBuffer"])
        fmt = "<H" if m.get("m_IndexFormat", 0) == 0 else "<I"
        sz = 2 if fmt == "<H" else 4
        tris = [struct.unpack_from(fmt, ib, i)[0] for i in range(0, len(ib), sz)]
        return {"verts": [[round(x, 5) for x in v[:3]] for v in verts], "uvs": [[round(x, 5) for x in u[:2]] for u in uvs] if uvs else None, "tris": tris}
    except Exception as e:  # noqa: BLE001 — keep converting the rest
        return {"error": str(e)}


def monos(name):
    """MonoBehaviours of the raw bundle (AssetRipper has no game dll to decode
    them): [(gameobject path, script name, fields)] plus a CRC32 → field-path
    table for the animation bindings AssetRipper writes as script_0x<crc>."""
    import warnings
    warnings.filterwarnings("ignore")
    raw = os.path.join(RAW_DIR, name + ".bundle")
    if not os.path.exists(raw):
        return [], {}
    env = UnityPy.load(raw)
    objs = {o.path_id: o for o in env.objects}
    names, father = {}, {}
    for o in env.objects:
        if o.type.name == "GameObject":
            names[o.path_id] = o.read().m_Name
        elif o.type.name in ("Transform", "RectTransform"):
            t = o.read_typetree()
            father[t["m_GameObject"]["m_PathID"]] = t["m_Father"]["m_PathID"]
    go_of_tf = {}
    for o in env.objects:
        if o.type.name in ("Transform", "RectTransform"):
            go_of_tf[o.path_id] = o.read_typetree()["m_GameObject"]["m_PathID"]

    def path(go):
        parts = []
        while go in names:
            parts.append(names[go])
            go = go_of_tf.get(father.get(go))
        return "/".join(reversed(parts))
    out, crc = [], {}

    def walk(prefix, v):
        if isinstance(v, dict):
            for k, x in v.items():
                walk(f"{prefix}.{k}" if prefix else k, x)
        else:
            crc[zlib.crc32(prefix.encode())] = prefix
    for o in env.objects:
        if o.type.name != "MonoBehaviour":
            continue
        t = o.read_typetree()
        sc = objs.get(t["m_Script"]["m_PathID"])
        script = sc.read().m_ClassName if sc else None
        fields = {}
        for k, v in t.items():
            if k in ("m_GameObject", "m_Script", "m_Name", "m_OnCullStateChanged"):
                continue
            if isinstance(v, dict) and "m_PathID" in v:
                tgt = objs.get(v["m_PathID"])
                v = {"type": tgt.type.name, "name": getattr(tgt.read(), "m_Name", None)} if tgt else None
            fields[k] = v
            walk(k, t[k])
        out.append((path(t["m_GameObject"]["m_PathID"]), script, fields))
    return out, crc


def find_by_name(fx, kind, nm):
    """Asset of `kind` (".asset" sprite / ".mat") named nm inside this effect's export dir."""
    d = os.path.join(EFFECT_DIR, fx.name)
    for f in glob.glob(os.path.join(d, nm + kind)) + glob.glob(os.path.join(ASSETS, "**", nm + kind), recursive=True)[:1]:
        with open(f + ".meta", errors="ignore") as m:
            g = re.search(r"guid: (\w+)", m.read(400))
        if g:
            return g.group(1)
    return None


def convert(name, prefab=None, unit=None):
    pf = prefab or os.path.join(EFFECT_DIR, name, f"{name}.prefab")
    if not os.path.exists(pf):
        cands = glob.glob(os.path.join(EFFECT_DIR, name, "*.prefab"))
        if not cands:
            return None
        pf = cands[0]
    docs = load_docs(pf)
    fx = Effect(name)
    nodes, idx = [], {}
    tr_of_go = {}
    for fid, (cls, b) in docs.items():
        if cls in (TRANSFORM, RECT):
            tr_of_go[str(b["m_GameObject"]["fileID"])] = fid
    for fid, (cls, b) in docs.items():
        if cls == GAMEOBJECT:
            idx[fid] = len(nodes)
            nodes.append({"go": fid})
    for n in nodes:
        go = docs[n["go"]][1]
        tf = tr_of_go.get(n["go"])
        t = docs[tf][1] if tf else {}
        n.update(name=go.get("m_Name"), active=go.get("m_IsActive", 1), layer=go.get("m_Layer", 0),
                 pos=[t.get("m_LocalPosition", {}).get(a, 0) for a in "xyz"],
                 rot=[t.get("m_LocalRotation", {}).get(a, 0 if a != "w" else 1) for a in "xyzw"],
                 scale=[t.get("m_LocalScale", {}).get(a, 1) for a in "xyz"],
                 _tf=tf, _father=str(t.get("m_Father", {}).get("fileID", 0)), _children=[str(c["fileID"]) for c in t.get("m_Children", [])])
        if docs.get(tf, (0,))[0] == RECT:
            n["rect"] = {"amin": [t["m_AnchorMin"]["x"], t["m_AnchorMin"]["y"]], "amax": [t["m_AnchorMax"]["x"], t["m_AnchorMax"]["y"]],
                         "apos": [t["m_AnchoredPosition"]["x"], t["m_AnchoredPosition"]["y"]],
                         "size": [t["m_SizeDelta"]["x"], t["m_SizeDelta"]["y"]], "pivot": [t["m_Pivot"]["x"], t["m_Pivot"]["y"]]}
        for c in go.get("m_Component", []):
            cid = str(c["component"]["fileID"])
            if cid not in docs:
                continue
            cls, b = docs[cid]
            if cls == PS:
                n["ps"] = particle_system(b)
            elif cls == PSR:
                n["psr"] = {k: b.get(k) for k in ("m_RenderMode", "m_SortingOrder", "m_SortingLayerID", "m_SortingFudge", "m_RenderAlignment",
                                                  "m_SortMode", "m_MinParticleSize", "m_MaxParticleSize", "m_LengthScale", "m_VelocityScale",
                                                  "m_CameraVelocityScale", "m_UseCustomVertexStreams", "m_VertexStreams", "m_Enabled")}
                n["psr"]["pivot"] = [b.get("m_Pivot", {}).get(a, 0) for a in "xyz"]
                n["psr"]["flip"] = [b.get("m_Flip", {}).get(a, 0) for a in "xyz"]
                n["psr"]["materials"] = [fx.material(m) for m in b.get("m_Materials") or []]
                if b.get("m_RenderMode") == 4:
                    n["psr"]["mesh"] = fx.mesh(b.get("m_Mesh"))
            elif cls == SPRITE_R:
                n["sprite"] = {"sprite": fx.sprite(b.get("m_Sprite")), "color": rgba(b.get("m_Color", {})), "order": b.get("m_SortingOrder", 0),
                               "flip": [b.get("m_FlipX", 0), b.get("m_FlipY", 0)], "drawMode": b.get("m_DrawMode", 0),
                               "size": [b.get("m_Size", {}).get("x", 1), b.get("m_Size", {}).get("y", 1)],
                               "materials": [fx.material(m) for m in b.get("m_Materials") or []], "enabled": b.get("m_Enabled", 1)}
            elif cls == MESH_R:
                n["meshR"] = {"materials": [fx.material(m) for m in b.get("m_Materials") or []], "order": b.get("m_SortingOrder", 0),
                              "enabled": b.get("m_Enabled", 1)}
            elif cls == MESH_F:
                n["mesh"] = fx.mesh(b.get("m_Mesh"))
            elif cls == ANIMATOR:
                n["animator"] = controller(fx, b.get("m_Controller"))
            elif cls == CANVAS:
                n["canvas"] = {k: b.get(k) for k in ("m_RenderMode", "m_PlaneDistance", "m_SortingOrder", "m_OverrideSorting", "m_PixelPerfect")}
            elif cls == SPRITE_MASK:
                n["spriteMask"] = {"sprite": fx.sprite(b.get("m_Sprite"))}
            elif cls == MONO:
                n.setdefault("scripts", []).append((ref(b.get("m_Script")) or [None, None, None])[1])
    # hierarchy
    by_tf = {n["_tf"]: i for i, n in enumerate(nodes) if n["_tf"]}
    for n in nodes:
        n["parent"] = by_tf.get(n["_father"], -1)
        n["children"] = [by_tf[c] for c in n["_children"] if c in by_tf]
    roots = [i for i, n in enumerate(nodes) if n["parent"] == -1]
    # scripted components (UI Image, ParticleShaderSettings, ScenarioEffector)
    def npath(i):
        parts = []
        while i != -1:
            parts.append(nodes[i]["name"])
            i = nodes[i]["parent"]
        return "/".join(reversed(parts))
    by_path = {npath(i): i for i in range(len(nodes))}
    mbs, crc = monos(name)
    for gpath, script, fields in mbs:
        i = by_path.get(gpath)
        if i is None:
            continue
        if script == "Image":
            sp = fields.get("m_Sprite")
            mat = fields.get("m_Material")
            sg = find_by_name(fx, ".asset", sp["name"]) if sp else None
            mg = find_by_name(fx, ".mat", mat["name"]) if mat else None
            nodes[i]["image"] = {"sprite": fx.sprite({"fileID": 21300000, "guid": sg}) if sg else None,
                                 "material": fx.material({"fileID": 2100000, "guid": mg}) if mg else None,
                                 "color": rgba(fields.get("m_Color", {})), "type": fields.get("m_Type", 0),
                                 "enabled": fields.get("m_Enabled", 1), "preserveAspect": fields.get("m_PreserveAspect", 0),
                                 "fill": [fields.get("m_FillMethod"), fields.get("m_FillAmount"), fields.get("m_FillOrigin"), fields.get("m_FillClockwise")]}
        elif script == "ParticleShaderSettings":
            nodes[i]["shaderMode"] = fields.get("mode", 0)
        elif script == "ScenarioEffector":
            nodes[i]["effector"] = {k: fields.get(k) for k in ("stopBehaviour", "finishBehaviour", "playOnEnable")}
        else:
            nodes[i].setdefault("other", []).append(script)
    for c in fx.clips.values():
        for cv in c["curves"]:
            m = re.match(r"script_0x([0-9A-Fa-f]+)", cv.get("attr") or "")
            if m:
                cv["attr"] = "script:" + crc.get(int(m.group(1), 16), cv["attr"])
    for n in nodes:
        for k in ("_tf", "_father", "_children", "go", "scripts"):
            n.pop(k, None)
    # sub-emitter references point at ParticleSystem fileIDs → node index
    ps_node = {}
    for fid, (cls, b) in docs.items():
        if cls == PS:
            go = str(b["m_GameObject"]["fileID"])
            if go in idx:
                ps_node[fid] = idx[go]
    for n in nodes:
        for e in (n.get("ps", {}).get("SubModule") or {}).get("subEmitters", []):
            e["emitter"] = ps_node.get(e["emitter"])
    os.makedirs(fx.dir, exist_ok=True)
    for src, dst in fx.textures.items():
        shutil.copy2(src, os.path.join(fx.dir, dst))
    out = {"name": name, "roots": roots, "nodes": nodes, "materials": fx.materials, "sprites": fx.sprites,
           "meshes": fx.meshes, "clips": fx.clips}
    if unit:
        out["unit"] = float(unit)
    with open(os.path.join(fx.dir, "effect.json"), "w") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    return out


def controller(fx, r):
    rr = ref(r)
    if not rr or rr[0] != "asset":
        return None
    path = guid_index().get(rr[1])
    if not path:
        return None
    docs = load_docs(path)
    states, layers_default = {}, None
    for fid, (cls, b) in docs.items():
        if cls == 1102:  # AnimatorState
            states[fid] = {"name": b.get("m_Name"), "clip": fx.clip(b.get("m_Motion")), "speed": b.get("m_Speed", 1),
                           "trans": [str(t["fileID"]) for t in b.get("m_Transitions") or []]}
        elif cls == 1107:  # AnimatorStateMachine
            d = ref(b.get("m_DefaultState"))
            if d:
                layers_default = d[1]
    trans = {}
    for fid, (cls, b) in docs.items():
        if cls == 1101:  # AnimatorStateTransition
            dst = ref(b.get("m_DstState"))
            trans[fid] = {"to": dst[1] if dst else None, "exit": b.get("m_HasExitTime", 0), "exitTime": b.get("m_ExitTime", 1),
                          "dur": b.get("m_TransitionDuration", 0), "conds": [c.get("m_ConditionEvent") for c in b.get("m_Conditions") or []]}
    for s in states.values():
        s["trans"] = [trans[t] for t in s["trans"] if t in trans]
    params = []
    for fid, (cls, b) in docs.items():
        if cls == 91:  # AnimatorController
            params = [p.get("m_Name") for p in b.get("m_AnimatorParameters") or []]
    return {"default": layers_default, "states": states, "params": params}


if __name__ == "__main__" and "prefab" in OPTS:
    print(bool(convert(OPTS["name"], OPTS["prefab"], OPTS.get("unit"))))
    sys.exit(0)

if __name__ == "__main__":
    names = sorted(os.listdir(EFFECT_DIR)) if not ONLY else sorted(ONLY)
    ok = 0
    for nm in names:
        try:
            if convert(nm):
                ok += 1
        except Exception as e:  # noqa: BLE001
            print("FAIL", nm, type(e).__name__, e)
    print("converted", ok, "/", len(names))
