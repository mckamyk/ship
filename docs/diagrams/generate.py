"""Generates tags-graph.svg and tags-lifecycle.svg. Run from the repo root: python3 docs/diagrams/generate.py"""
import sys
from html import escape

OUT = sys.argv[1] if len(sys.argv) > 1 else "docs/diagrams"

STYLE = """<style>
svg{--bg:#ffffff;--border:#d0d7de;--grid:#eaeef2;--fg:#1f2328;--muted:#656d76;--line:#57606a;
--staging:#9a6700;--staging-bg:#fff8c5;--prod:#1a7f37;--prod-bg:#dafbe1;--infra:#8250df;--infra-bg:#fbefff}
@media (prefers-color-scheme:dark){svg{--bg:#0d1117;--border:#30363d;--grid:#21262d;--fg:#e6edf3;--muted:#8d96a0;--line:#8b949e;
--staging:#d29922;--staging-bg:#2e2410;--prod:#3fb950;--prod-bg:#11281a;--infra:#a371f7;--infra-bg:#24193f}}
text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;fill:var(--fg)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"DejaVu Sans Mono",monospace}
.title{font-size:18px;font-weight:600}.sub{font-size:13px;fill:var(--muted)}
.note{font-size:11.5px;fill:var(--muted)}.small{font-size:11px;fill:var(--muted)}
.cap{font-size:11.5px;fill:var(--fg)}
</style>"""

FAMILY = {"staging": "staging", "prod": "prod", "infra": "infra"}
CHAR = 7.6  # generous monospace advance at 12.5px


def fam(tag):
    return FAMILY[tag.split("/")[0]]


def pill(x, cy, tag, ghost=False, anchor="start"):
    f = fam(tag)
    w = len(tag) * CHAR + 16
    if anchor == "middle":
        x -= w / 2
    if ghost:
        rect = f'<rect x="{x}" y="{cy-11}" width="{w}" height="22" rx="5" fill="none" stroke="var(--{f})" stroke-dasharray="4 3" opacity=".8"/>'
        txt = f'<text class="mono" x="{x+8}" y="{cy+4.3}" font-size="12.5" style="fill:var(--{f})" opacity=".8">{escape(tag)}</text>'
    else:
        rect = f'<rect x="{x}" y="{cy-11}" width="{w}" height="22" rx="5" style="fill:var(--{f}-bg)" stroke="var(--{f})" stroke-opacity=".45"/>'
        txt = f'<text class="mono" x="{x+8}" y="{cy+4.3}" font-size="12.5" style="fill:var(--{f})" font-weight="600">{escape(tag)}</text>'
    return rect + txt, w


def frame(w, h, body, label):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" role="img" aria-label="{escape(label)}">'
        f"{STYLE}"
        f'<rect x=".5" y=".5" width="{w-1}" height="{h-1}" rx="10" style="fill:var(--bg)" stroke="var(--border)"/>'
        + body
        + "</svg>\n"
    )


# ---------------------------------------------------------------- lifecycle
def lifecycle():
    W = 1000
    x0, colw = 250, 100
    cx = lambda step: x0 + (step - 0.5) * colw
    end_x = x0 + 7 * colw + 26
    steps = [
        ["checkout-flow", "→ staging"],
        ["search-bar", "→ staging"],
        ["checkout-flow", "→ staging again", "(new commit)"],
        ["checkout-flow", "→ production"],
        ["Finish infra", "split-vpc, then", "rebuild staging"],
        ["Bring missing", "infra to dev"],
        ["Remove", "search-bar", "from staging"],
    ]
    rows = [
        ("staging/checkout-flow", [(1, "c", "A1"), (3, "m", "A2"), (4, "d", "")]),
        ("staging/search-bar", [(2, "c", "S1"), (7, "d", "")]),
        None,
        ("prod/latest", [(4, "c", "M1"), (5, "m", "M2")]),
        ("prod/checkout-flow", [(4, "c", "M1")]),
        ("prod/split-vpc", [(5, "c", "M2")]),
        None,
        ("infra/prod/split-vpc", [(5, "c", "M2")]),
        ("infra/staging/split-vpc", [(5, "c", "M2")]),
        ("infra/dev/split-vpc", [(6, "c", "M2")]),
    ]
    b = []
    b.append('<text class="title" x="24" y="38">How ship moves its tags</text>')
    b.append('<text class="sub" x="24" y="60">One example run, left to right. Each row is a tag on origin; the label above a marker is the commit it points at.</text>')

    top = 92
    for i, cap in enumerate(steps, start=1):
        x = cx(i)
        b.append(f'<circle cx="{x}" cy="{top}" r="11" style="fill:var(--fg)"/>')
        b.append(f'<text x="{x}" y="{top+4.5}" text-anchor="middle" font-size="12" font-weight="700" style="fill:var(--bg)">{i}</text>')
        for j, line in enumerate(cap):
            b.append(f'<text class="cap" x="{x}" y="{top+30+j*15}" text-anchor="middle">{escape(line)}</text>')

    y = 178
    row_ys = []
    for row in rows:
        if row is None:
            y += 14
            continue
        row_ys.append((y, row))
        y += 40
    grid_top, grid_bottom = 160, y - 14
    for i in range(1, 8):
        b.append(f'<line x1="{cx(i)}" y1="{grid_top}" x2="{cx(i)}" y2="{grid_bottom}" stroke="var(--grid)" stroke-width="1.5"/>')

    for ry, (tag, events) in row_ys:
        f = fam(tag)
        p, _ = pill(24, ry, tag)
        b.append(p)
        start = cx(events[0][0])
        last = events[-1]
        stop = cx(last[0]) if last[1] == "d" else end_x
        b.append(f'<line x1="{start}" y1="{ry}" x2="{stop}" y2="{ry}" stroke="var(--{f})" stroke-width="3" stroke-linecap="round" opacity=".55"/>')
        if last[1] != "d":
            b.append(f'<path d="M{end_x-7} {ry-5} L{end_x+1} {ry} L{end_x-7} {ry+5}" fill="none" stroke="var(--{f})" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" opacity=".7"/>')
        for step, kind, commit in events:
            x = cx(step)
            if kind == "c":
                b.append(f'<circle cx="{x}" cy="{ry}" r="6.5" style="fill:var(--{f})"/>')
            elif kind == "m":
                b.append(f'<circle cx="{x}" cy="{ry}" r="6.5" style="fill:var(--bg)" stroke="var(--{f})" stroke-width="2.6"/>')
            else:
                b.append(f'<path d="M{x-5.5} {ry-5.5} L{x+5.5} {ry+5.5} M{x+5.5} {ry-5.5} L{x-5.5} {ry+5.5}" stroke="var(--{f})" stroke-width="2.6" stroke-linecap="round"/>')
            if commit:
                b.append(f'<text class="mono small" x="{x}" y="{ry-11}" text-anchor="middle">{commit}</text>')

    ly = grid_bottom + 34
    lx = 24
    b.append(f'<line x1="{lx}" y1="{ly-20}" x2="{W-24}" y2="{ly-20}" stroke="var(--border)"/>')
    items = [
        ('<circle cx="{x}" cy="{y}" r="6" style="fill:var(--line)"/>', "created"),
        ('<circle cx="{x}" cy="{y}" r="6" style="fill:var(--bg)" stroke="var(--line)" stroke-width="2.4"/>', "moved to a newer commit"),
        ('<path d="M{a} {c} L{b} {d} M{b} {c} L{a} {d}" stroke="var(--line)" stroke-width="2.4" stroke-linecap="round"/>', "deleted"),
        ('<path d="M{a} {c} L{x2} {y} L{a} {d}" fill="none" stroke="var(--line)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>', "still there"),
    ]
    x = lx + 6
    for shape, label in items:
        b.append(shape.format(x=x, y=ly, a=x - 5, b=x + 5, c=ly - 5, d=ly + 5, x2=x + 3))
        b.append(f'<text class="note" x="{x+14}" y="{ly+4}">{label}</text>')
        x += 30 + len(label) * 6.6
    b.append(f'<text class="note" x="{lx}" y="{ly+28}">A1, A2: commits on ship/checkout-flow · S1: ship/search-bar · M1, M2: the squash commits on main. Tags only change after a deploy succeeds.</text>')
    H = ly + 48
    return frame(W, H, "".join(b), "Diagram of how ship creates, moves and deletes its staging, prod and infra tags over an example run")


# ---------------------------------------------------------------- graph
def graph():
    W, H = 1040, 486
    LANE = {"staging": 128, "search": 196, "main": 276, "checkout": 356, "infra": 426}
    X = {"M0": 210, "A1": 290, "A2": 370, "S1": 300, "M1": 460, "I1": 545, "M2": 630, "ST": 770}
    b = []
    b.append('<text class="title" x="24" y="38">Where the tags point</text>')
    b.append('<text class="sub" x="24" y="60">After checkout-flow and the split-vpc Infrastructure Change reached production, with search-bar still on staging.</text>')

    labels = [
        ("staging", "staging", "branch, rebuilt each time", False),
        ("search", "ship/search-bar", "Staged Feature", False),
        ("main", "main", "matches production", False),
        ("checkout", "ship/checkout-flow", "deleted once shipped", True),
        ("infra", "infra/split-vpc", "deleted once shipped", True),
    ]
    for lane, name, hint, ghost in labels:
        y = LANE[lane]
        op = ' opacity=".6"' if ghost else ""
        b.append(f'<text class="mono" x="24" y="{y-1}" font-size="12.5" font-weight="600"{op}>{name}</text>')
        b.append(f'<text class="small" x="24" y="{y+14}">{hint}</text>')

    line = 'fill="none" stroke="var(--line)" stroke-width="2.5" stroke-linecap="round"'
    ghost = 'fill="none" stroke="var(--line)" stroke-width="2" stroke-dasharray="5 4" opacity=".55"'
    m, s, c, i = LANE["main"], LANE["staging"], LANE["checkout"], LANE["infra"]
    sb = LANE["search"]
    # main
    b.append(f'<path d="M172 {m} L{X["M2"]} {m}" {line}/>')
    # ghost branches and their squash arrows
    b.append(f'<path d="M{X["M0"]} {m} C{X["M0"]} {c-30}, {X["M0"]+20} {c}, {X["A1"]-30} {c} L{X["A2"]} {c}" {ghost}/>')
    b.append(f'<path d="M{X["A2"]} {c} C{X["A2"]+50} {c}, {X["M1"]-6} {c-30}, {X["M1"]-4} {m+20}" {ghost}/>')
    b.append(f'<path d="M{X["M1"]-9} {m+21} L{X["M1"]-4} {m+14} L{X["M1"]+2} {m+21}" {ghost.replace("stroke-dasharray=\"5 4\" ", "")}/>')
    b.append(f'<text class="small" x="{X["A2"]+38}" y="{c-14}">squash</text>')
    b.append(f'<path d="M{X["M1"]} {m} C{X["M1"]} {i-30}, {X["M1"]+20} {i}, {X["I1"]-40} {i} L{X["I1"]} {i}" {ghost}/>')
    b.append(f'<path d="M{X["I1"]} {i} C{X["I1"]+55} {i}, {X["M2"]-6} {i-40}, {X["M2"]-4} {m+20}" {ghost}/>')
    b.append(f'<path d="M{X["M2"]-9} {m+21} L{X["M2"]-4} {m+14} L{X["M2"]+2} {m+21}" {ghost.replace("stroke-dasharray=\"5 4\" ", "")}/>')
    b.append(f'<text class="small" x="{X["I1"]+40}" y="{i-16}">squash</text>')
    # search-bar branch, merged into the staging rebuild
    b.append(f'<path d="M{X["M0"]} {m} C{X["M0"]} {sb+30}, {X["M0"]+20} {sb}, {X["S1"]-40} {sb} L{X["S1"]} {sb}" {line}/>')
    b.append(f'<path d="M{X["S1"]} {sb} L{X["ST"]-40} {sb} C{X["ST"]-10} {sb}, {X["ST"]} {sb-20}, {X["ST"]} {s+12}" {line}/>')
    # staging rebuilt from latest main
    b.append(f'<path d="M{X["M2"]} {m} C{X["M2"]} {s+40}, {X["M2"]+30} {s}, {X["M2"]+80} {s} L{X["ST"]} {s}" {line}/>')

    # commits
    def dot(x, y, label, below=True, ghosted=False):
        op = ' opacity=".55"' if ghosted else ""
        b.append(f'<circle cx="{x}" cy="{y}" r="12" style="fill:var(--bg)" stroke="var(--line)" stroke-width="2.5"{op}/>')
        b.append(f'<text class="mono" x="{x}" y="{y+3.8}" font-size="10.5" font-weight="600" text-anchor="middle"{op}>{label}</text>')

    dot(X["M0"], m, "M0")
    dot(X["M1"], m, "M1")
    dot(X["M2"], m, "M2", below=False)
    dot(X["A1"], c, "A1", ghosted=True)
    dot(X["A2"], c, "A2", ghosted=True)
    dot(X["I1"], i, "I1", ghosted=True)
    dot(X["S1"], sb, "S1", below=True)
    dot(X["ST"], s, "", below=False)
    b.append(f'<text class="small" x="{X["ST"]+16}" y="{s+4}">latest main + every Staged Feature</text>')

    # tags
    def connector(x1, y1, x2, y2):
        b.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="var(--border)" stroke-width="1.5"/>')

    # staging/search-bar on S1
    connector(X["S1"], sb - 12, X["S1"], sb - 25)
    p, w = pill(X["S1"], sb - 36, "staging/search-bar", anchor="middle")
    b.append(p)
    b.append(f'<text class="note" x="{X["S1"]+w/2+10}" y="{sb-32}">the exact commit staging was built with</text>')
    # prod/checkout-flow on M1
    connector(X["M1"], m - 12, X["M1"], m - 25)
    p, w = pill(X["M1"], m - 36, "prod/checkout-flow", anchor="middle")
    b.append(p)
    # M2's stack
    stack = [
        ("prod/latest", "moves on each prod deploy", False),
        ("prod/split-vpc", "permanent, one per Work", False),
        ("infra/prod/split-vpc", "permanent: prod has it", False),
        ("infra/staging/split-vpc", "staging has it", False),
        ("infra/dev/split-vpc", "missing on dev", True),
    ]
    bx, px = X["M2"] + 26, X["M2"] + 40
    top = m + 34
    ys = [top + k * 28 for k in range(len(stack))]
    b.append(f'<path d="M{X["M2"]+12} {m} L{bx} {m} L{bx} {ys[-2]}" fill="none" stroke="var(--border)" stroke-width="1.5"/>')
    b.append(f'<path d="M{bx} {ys[-2]} L{bx} {ys[-1]}" fill="none" stroke="var(--border)" stroke-width="1.5" stroke-dasharray="3 3"/>')
    widest = max(len(t) for t, _, _ in stack) * CHAR + 16
    for (tag, note, gh), y in zip(stack, ys):
        b.append(f'<line x1="{bx}" y1="{y}" x2="{px}" y2="{y}" stroke="var(--border)" stroke-width="1.5"{" stroke-dasharray=\"3 3\"" if gh else ""}/>')
        p, w = pill(px, y, tag, ghost=gh)
        b.append(p)
        b.append(f'<text class="note" x="{px+widest+12}" y="{y+4}">{note}</text>')
    return frame(W, H, "".join(b), "Git graph showing which commits ship's staging, prod and infra tags point at")


with open(f"{OUT}/tags-lifecycle.svg", "w") as fh:
    fh.write(lifecycle())
with open(f"{OUT}/tags-graph.svg", "w") as fh:
    fh.write(graph())
