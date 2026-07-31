import base64, re, sys, zipfile, os, html

BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, "_extracted")
os.makedirs(OUT, exist_ok=True)

# 1. Extract base64 images from Rough_idea.md
md = open(os.path.join(BASE, "Rough_idea.md"), encoding="utf-8", errors="replace").read()
for m in re.finditer(r"\[(image\d+)\]:\s*<data:image/(\w+);base64,([A-Za-z0-9+/=]+)>", md):
    name, ext, data = m.group(1), m.group(2), m.group(3)
    p = os.path.join(OUT, f"{name}.{ext}")
    with open(p, "wb") as f:
        f.write(base64.b64decode(data))
    print("IMG", p, os.path.getsize(p))

# 2. Extract text from pptx
def pptx_text(path):
    out = []
    with zipfile.ZipFile(path) as z:
        slides = sorted(
            [n for n in z.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)],
            key=lambda n: int(re.search(r"(\d+)", n).group(1)),
        )
        notes = {n: True for n in z.namelist() if "notesSlide" in n}
        for s in slides:
            xml = z.read(s).decode("utf-8", "replace")
            texts = re.findall(r"<a:t>(.*?)</a:t>", xml, re.S)
            num = re.search(r"(\d+)", s).group(1)
            out.append(f"\n===== SLIDE {num} ({os.path.basename(path)}) =====")
            for t in texts:
                t = html.unescape(t).strip()
                if t:
                    out.append(t)
            nspath = f"ppt/notesSlides/notesSlide{num}.xml"
            if nspath in notes:
                nxml = z.read(nspath).decode("utf-8", "replace")
                ntexts = [html.unescape(t).strip() for t in re.findall(r"<a:t>(.*?)</a:t>", nxml, re.S)]
                ntexts = [t for t in ntexts if t and t != num]
                if ntexts:
                    out.append("--- NOTES: " + " ".join(ntexts))
        # images inside pptx
        imgs = [n for n in z.namelist() if n.startswith("ppt/media/")]
        base = os.path.splitext(os.path.basename(path))[0]
        d = os.path.join(OUT, base + "_media")
        os.makedirs(d, exist_ok=True)
        for i in imgs:
            with open(os.path.join(d, os.path.basename(i)), "wb") as f:
                f.write(z.read(i))
        out.append(f"\n[{len(imgs)} media files -> {d}]")
    return "\n".join(out)

for f in ["Ascendant_Agents_Tracks.pptx", "Submission_PPT.pptx"]:
    txt = pptx_text(os.path.join(BASE, f))
    p = os.path.join(OUT, f.replace(".pptx", "_text.txt"))
    open(p, "w", encoding="utf-8").write(txt)
    print("PPTX", p, len(txt), "chars")
