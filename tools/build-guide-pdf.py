#!/usr/bin/env python3
"""Build Tiksi's printable feature guide from the shared guide content.

Requires ReportLab (available in the bundled Codex Python runtime). Example:
  python tools/build-guide-pdf.py --content /tmp/guide.json \
      --assets js/guide-assets --output output/pdf/tiksi-feature-guide.pdf

The JSON root must contain ``chapters`` and ``viewMap`` arrays. Screenshots are
resolved only beneath --assets; video demonstrations remain in the online guide
and have their text transcripts included in print. This script never reads a
project store, opens the browser, or downloads assets.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path
from urllib.parse import quote
from xml.sax.saxutils import escape

try:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.utils import ImageReader
    from reportlab.platypus import (
        BaseDocTemplate,
        CondPageBreak,
        Flowable,
        Frame,
        Image,
        KeepTogether,
        PageBreak,
        PageTemplate,
        Paragraph,
        Spacer,
        Table,
        TableStyle,
    )
    from reportlab.platypus.tableofcontents import TableOfContents
except ImportError as exc:
    raise SystemExit("ReportLab is required. Run with the bundled Python runtime.") from exc


INK = colors.HexColor("#18352e")
BODY = colors.HexColor("#203b34")
MUTED = colors.HexColor("#50645e")
ACCENT = colors.HexColor("#1c6753")
LINE = colors.HexColor("#cfdbd4")
PAPER = colors.HexColor("#f0f5f1")
PAGE_W, PAGE_H = letter
LEFT, RIGHT, TOP, BOTTOM = 45, 45, 52, 43
WIDTH = PAGE_W - LEFT - RIGHT


def plain(value: object) -> str:
    """Use predictable built-in-font glyphs without losing ordinary words."""
    text = str(value or "")
    substitutions = {
        "\u2192": " > ", "\u2190": " < ", "\u2194": " <-> ",
        "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-",
        "\u2014": "-", "\u2212": "-", "\u2018": "'", "\u2019": "'",
        "\u201c": '"', "\u201d": '"', "\u2026": "...", "\u00a0": " ",
        "\u00d7": " x ", "\u00b2": "2", "\u2022": " / ",
    }
    for source, replacement in substitutions.items():
        text = text.replace(source, replacement)
    # Helvetica uses WinAnsi. Decompose any unsupported accented characters,
    # retaining meaningful readable text rather than a missing-glyph box.
    result = []
    for char in text:
        try:
            char.encode("cp1252")
            result.append(char)
        except UnicodeEncodeError:
            result.append(unicodedata.normalize("NFKD", char).encode("ascii", "ignore").decode())
    return "".join(result)


def rich(value: object) -> str:
    return escape(plain(value)).replace("\n", "<br/>")


def styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()["BodyText"]
    common = dict(fontName="Helvetica", textColor=BODY, fontSize=10, leading=13.7,
                  spaceBefore=0, spaceAfter=7, allowWidows=0, allowOrphans=0)
    result = {"body": ParagraphStyle("GuideBody", parent=base, **common)}
    result["intro"] = ParagraphStyle("GuideIntro", parent=result["body"], fontSize=11,
                                     leading=15.3, spaceAfter=12)
    result["eyebrow"] = ParagraphStyle("GuideEyebrow", parent=result["body"],
                                      fontName="Helvetica-Bold", fontSize=8.5,
                                      leading=11, textColor=ACCENT, spaceAfter=7,
                                      keepWithNext=True)
    result["chapter"] = ParagraphStyle("GuideChapter", parent=result["body"],
                                      fontName="Helvetica-Bold", fontSize=23,
                                      leading=27, textColor=INK, spaceAfter=12,
                                      keepWithNext=True)
    result["section"] = ParagraphStyle("GuideSection", parent=result["body"],
                                      fontName="Helvetica-Bold", fontSize=12,
                                      leading=16, textColor=INK, spaceBefore=9,
                                      spaceAfter=7, keepWithNext=True)
    result["caption"] = ParagraphStyle("GuideCaption", parent=result["body"],
                                      fontSize=8.7, leading=11.6, textColor=MUTED,
                                      spaceBefore=5, spaceAfter=11)
    result["small"] = ParagraphStyle("GuideSmall", parent=result["body"],
                                    fontSize=9, leading=12.5, textColor=MUTED,
                                    spaceAfter=7)
    result["number"] = ParagraphStyle("GuideStepNumber", parent=result["body"],
                                     fontName="Helvetica-Bold", textColor=ACCENT)
    result["note"] = ParagraphStyle("GuideNote", parent=result["body"],
                                   fontSize=9, leading=12.5, spaceAfter=0)
    result["cover"] = ParagraphStyle("GuideCover", parent=result["chapter"],
                                    fontSize=38, leading=42, spaceAfter=16)
    result["toc"] = ParagraphStyle("GuideContents", parent=result["body"],
                                  fontSize=10.5, leading=14.6, spaceAfter=4,
                                  leftIndent=0, firstLineIndent=0,
                                  rightIndent=24)
    result["map-label"] = ParagraphStyle("GuideMapLabel", parent=result["small"],
                                        fontName="Helvetica-Bold", textColor=ACCENT,
                                        fontSize=8.5, leading=11.5, spaceAfter=0)
    result["map-body"] = ParagraphStyle("GuideMapBody", parent=result["small"],
                                       fontSize=9, leading=12.2, spaceAfter=0)
    return result


class Rule(Flowable):
    def __init__(self, width: float = WIDTH, space_after: float = 10):
        super().__init__()
        self.width = width
        self.height = 1 + space_after

    def draw(self):
        self.canv.setStrokeColor(LINE)
        self.canv.setLineWidth(0.6)
        self.canv.line(0, self.height - 1, self.width, self.height - 1)


class ChapterHeading(Paragraph):
    def __init__(self, text, style, chapter_id, number):
        super().__init__(text, style)
        self.chapter_id = chapter_id
        self.chapter_number = number
        self.chapter_title = plain(re.sub("<[^>]+>", "", text))


class GuideDoc(BaseDocTemplate):
    def __init__(self, filename, **kwargs):
        super().__init__(filename, pagesize=letter, leftMargin=LEFT, rightMargin=RIGHT,
                         topMargin=TOP, bottomMargin=BOTTOM, title="Tiksi feature guide",
                         author="Tiksi", subject="Illustrated guide to Tiksi's workspaces and workflows",
                         pageCompression=1, **kwargs)
        self.current_chapter = "Feature guide"
        self.current_chapter_page = 1
        self.in_front_matter = True
        frame = Frame(LEFT, BOTTOM, WIDTH, PAGE_H - TOP - BOTTOM,
                      leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0,
                      id="guide-body")
        self.addPageTemplates(PageTemplate(id="Guide", frames=frame, onPageEnd=self.page_furniture))

    def beforeDocument(self):
        # multiBuild reruns the story for table-of-contents page numbers.
        self.current_chapter = "Feature guide"
        self.current_chapter_page = 1
        self.in_front_matter = True
        self.canv.setTitle("Tiksi feature guide")
        self.canv.setAuthor("Tiksi")

    def beforePage(self):
        # Chapters may share a page. The running head describes the material
        # at the top of the page, rather than the last chapter encountered.
        self.page_chapter = self.current_chapter
        self.page_chapter_start = self.current_chapter_page
        self.page_front_matter = self.in_front_matter
        self.page_has_content = False

    def afterFlowable(self, flowable):
        if isinstance(flowable, ChapterHeading):
            key = "chapter-" + flowable.chapter_id
            self.current_chapter = flowable.chapter_title
            self.current_chapter_page = self.page
            self.in_front_matter = False
            if not self.page_has_content:
                self.page_chapter = self.current_chapter
                self.page_chapter_start = self.page
                self.page_front_matter = False
            self.page_has_content = True
            self.canv.bookmarkPage(key)
            self.canv.addOutlineEntry(flowable.chapter_title, key, level=0, closed=False)
            self.notify("TOCEntry", (0, f"{flowable.chapter_number:02d}   {rich(flowable.chapter_title)}",
                                     self.page, key))
        elif isinstance(flowable, (Paragraph, Table, Image)) and not getattr(flowable, "chapter_lead", False):
            self.page_has_content = True

    def page_furniture(self, canvas, doc):
        canvas.saveState()
        if self.page > 1:
            canvas.setStrokeColor(LINE)
            canvas.setLineWidth(0.5)
            canvas.line(LEFT, PAGE_H - 31, PAGE_W - RIGHT, PAGE_H - 31)
            canvas.setFont("Helvetica-Bold", 8)
            canvas.setFillColor(ACCENT)
            canvas.drawString(LEFT, PAGE_H - 24, "TIKSI")
            label = "Feature guide" if self.page_front_matter else self.page_chapter
            if not self.page_front_matter and self.page > self.page_chapter_start:
                label += " / continued"
            canvas.setFont("Helvetica", 8)
            canvas.setFillColor(MUTED)
            canvas.drawRightString(PAGE_W - RIGHT, PAGE_H - 24, label)
        canvas.setStrokeColor(LINE)
        canvas.setLineWidth(0.5)
        canvas.line(LEFT, 30, PAGE_W - RIGHT, 30)
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(MUTED)
        canvas.drawString(LEFT, 18, "Tiksi feature guide  /  Synthetic demonstration data")
        canvas.drawRightString(PAGE_W - RIGHT, 18, str(self.page))
        canvas.restoreState()


def screenshot(asset_root: Path, filename: str) -> Image:
    root = asset_root.resolve()
    path = (root / filename).resolve()
    if not path.is_relative_to(root):
        raise ValueError(f"Screenshot must be beneath --assets: {filename}")
    if not path.is_file():
        raise ValueError(f"Missing guide screenshot: {path}")
    image = ImageReader(str(path))
    iw, ih = image.getSize()
    # Keep the UI legible and zoomable: the standard 1440x960 captures span the
    # full text column. Taller future captures fit inside a sensible page block.
    scale = min(WIDTH / iw, (4.85 * 72) / ih)
    result = Image(str(path), width=iw * scale, height=ih * scale, hAlign="LEFT")
    result.spaceBefore = 1
    result.spaceAfter = 0
    return result


def callout(text: str, sty: dict, *, label: str = "Keep in mind") -> Table:
    content = Paragraph(f"<b>{rich(label)}.</b> {rich(text)}", sty["note"])
    table = Table([[content]], colWidths=[WIDTH])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), PAPER),
        ("LINEBEFORE", (0, 0), (0, -1), 2, ACCENT),
        ("LEFTPADDING", (0, 0), (-1, -1), 11),
        ("RIGHTPADDING", (0, 0), (-1, -1), 11),
        ("TOPPADDING", (0, 0), (-1, -1), 9),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
    ]))
    table.spaceBefore = 7
    table.spaceAfter = 9
    return table


def numbered_step(index: int, text: str, sty: dict) -> Table:
    result = Table([[Paragraph(f"{index:02d}", sty["number"]), Paragraph(rich(text), sty["body"])]],
                   colWidths=[25, WIDTH - 25])
    result.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return result


def validate(content: object) -> tuple[list[dict], list[dict]]:
    if not isinstance(content, dict):
        raise ValueError("Content JSON must be an object with chapters and viewMap arrays.")
    chapters, view_map = content.get("chapters"), content.get("viewMap")
    if not isinstance(chapters, list) or not chapters:
        raise ValueError("Content must contain a nonempty chapters array.")
    if not isinstance(view_map, list):
        raise ValueError("Content must contain a viewMap array.")
    ids = set()
    for chapter in chapters:
        if not isinstance(chapter, dict) or not chapter.get("title") or not chapter.get("id"):
            raise ValueError("Every chapter needs an id and title.")
        if not re.fullmatch(r"[A-Za-z0-9_-]+", chapter["id"]):
            raise ValueError(f"Invalid chapter id: {chapter['id']}")
        if chapter["id"] in ids:
            raise ValueError(f"Duplicate chapter id: {chapter['id']}")
        ids.add(chapter["id"])
        for field in ("steps", "features", "related"):
            if field in chapter and not isinstance(chapter[field], list):
                raise ValueError(f"{chapter['id']}.{field} must be an array.")
        for feature in chapter.get("features", []):
            if not isinstance(feature, list) or len(feature) != 2:
                raise ValueError(f"{chapter['id']}.features entries need a label and description.")
    for chapter in chapters:
        unknown = set(chapter.get("related", [])) - ids
        if unknown:
            raise ValueError(f"Unknown related chapters in {chapter['id']}: {sorted(unknown)}")
    return chapters, view_map


def build_story(chapters: list[dict], view_map: list[dict], asset_root: Path,
                guide_url: str, edition: str) -> list:
    sty = styles()
    story = [Spacer(1, 25), Paragraph("TIKSI / FIELD GUIDE", sty["eyebrow"]),
             Paragraph("A room, a design,<br/>a project.", sty["cover"]),
             Paragraph("An illustrated feature guide", sty["intro"]),
             Rule(),
             Paragraph("Find the controls, learn the workflows, and carry the work from capture to a plan, "
                       "a 3D model, finishes, scope, budget and a useful handoff.", sty["intro"])]
    # A short navigation map on the cover makes the manual useful even before
    # the reader chooses a chapter. All workspace descriptions stay in sync.
    story.append(Paragraph("Where everything lives", sty["section"]))
    rows = []
    for view in view_map:
        rows.append([Paragraph(rich(view.get("label", "")), sty["map-label"]),
                     Paragraph(rich(view.get("purpose", "")), sty["map-body"])])
    if rows:
        table = Table(rows, colWidths=[92, WIDTH - 92])
        table.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 7),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("LINEBELOW", (0, 0), (-1, -1), 0.35, LINE),
        ]))
        story.append(table)
    story.extend([Spacer(1, 12), Paragraph(rich(edition), sty["small"]),
                  Paragraph("Illustrations, recordings, products and prices use a synthetic sample renovation. "
                            "They demonstrate controls, not a surveyed room, supplier quote or completed reconstruction.",
                            sty["small"]), PageBreak(),
                  Paragraph("Find your next step", sty["chapter"]),
                  Paragraph("Chapters follow the work from a first session through capture, design and project planning. "
                            "Page numbers, chapter titles and related-chapter links are clickable in a PDF reader.",
                            sty["intro"])])
    toc = TableOfContents()
    toc.levelStyles = [sty["toc"]]
    toc.dotsMinLevel = 0
    story.append(toc)
    story.append(Spacer(1, 10))
    story.append(KeepTogether([
        callout("Short videos and GIFs are available in the in-app guide. Each printed demo includes "
                "a transcript and a chapter link. Open the linked chapter in a browser to watch. "
                "Features using local engines still require the local Tiksi server.",
                sty, label="Watch the demonstrations"),
        Paragraph(f'<link href="{escape(guide_url, {chr(34): "&quot;"})}" color="#1c6753">'
                  f'Open the in-app feature guide</link> - {rich(guide_url)}', sty["small"]),
    ]))
    titles = {chapter["id"]: chapter["title"] for chapter in chapters}
    for index, chapter in enumerate(chapters, 1):
        chapter_start = []
        if index == 1:
            story.append(PageBreak())
        else:
            story.extend([Spacer(1, 14), CondPageBreak(180)])
            chapter_start.append(Rule(space_after=13))
        label = f"{index:02d} / {chapter.get('group', 'Feature guide')}"
        if chapter.get("path"):
            label += "  /  " + chapter["path"]
        lead = Paragraph(rich(label.upper()), sty["eyebrow"])
        lead.chapter_lead = True
        chapter_start.append(lead)
        chapter_start.append(ChapterHeading(rich(chapter["title"]), sty["chapter"], chapter["id"], index))
        if chapter.get("intro"):
            chapter_start.append(Paragraph(rich(chapter["intro"]), sty["intro"]))
        if chapter.get("image"):
            chapter_start.append(screenshot(asset_root, chapter["image"]))
            if chapter.get("caption"):
                chapter_start.append(Paragraph(rich(chapter["caption"]), sty["caption"]))
            else:
                chapter_start.append(Spacer(1, 10))
        elif chapter.get("caption"):
            chapter_start.append(Paragraph(rich(chapter["caption"]), sty["caption"]))
        # A chapter begins with its visual context. The complete leading block
        # fits a page, while later instructions and details may flow normally.
        story.append(KeepTogether(chapter_start))
        if chapter.get("steps"):
            story.append(Paragraph(rich(chapter.get("stepsTitle", "Try it")), sty["section"]))
            story.extend(numbered_step(number, step, sty) for number, step in enumerate(chapter["steps"], 1))
        if chapter.get("features"):
            story.append(Paragraph("Useful details", sty["section"]))
            for feature, description in chapter["features"]:
                story.append(Paragraph(f"<b>{rich(feature)}.</b> {rich(description)}", sty["body"]))
        if chapter.get("clip") or chapter.get("gif") or chapter.get("transcript"):
            story.append(Paragraph("Demo: " + rich(chapter.get("clipTitle", chapter["title"])), sty["section"]))
            if chapter.get("transcript"):
                story.append(Paragraph(rich(chapter["transcript"]), sty["body"]))
            chapter_url = guide_url.split("?")[0] + "?topic=" + quote(chapter["id"])
            story.append(Paragraph(f'<link href="{escape(chapter_url, {chr(34): "&quot;"})}" color="#1c6753">'
                                   'Watch this demonstration in the in-app guide</link>.', sty["small"]))
        tail = []
        if chapter.get("note"):
            tail.append(callout(chapter["note"], sty))
        if chapter.get("related"):
            related = " / ".join(f'<link href="#chapter-{item}" color="#1c6753">{rich(titles[item])}</link>'
                                 for item in chapter["related"])
            # Keep a related-chapter link from becoming the sole line on a page.
            if not tail:
                tail.append(story.pop())
            tail.append(Paragraph("<b>Continue with:</b> " + related, sty["small"]))
        if tail:
            story.append(KeepTogether(tail))
    return story


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
                                     allow_abbrev=False)
    parser.add_argument("--content", required=True, type=Path, help="JSON export containing chapters and viewMap")
    parser.add_argument("--assets", required=True, type=Path, help="Directory of synthetic guide screenshots")
    parser.add_argument("--output", required=True, type=Path, help="Destination PDF")
    parser.add_argument("--guide-url", default="http://localhost:8642/#/guide", help="URL of the in-app guide")
    parser.add_argument("--edition", default="Tiksi feature walkthrough", help="Edition label printed on the cover")
    args = parser.parse_args()
    try:
        content = json.loads(args.content.read_text(encoding="utf-8"))
        chapters, view_map = validate(content)
        if not args.guide_url.startswith(("https://", "http://")):
            raise ValueError("--guide-url must be an http or https URL.")
        story = build_story(chapters, view_map, args.assets, args.guide_url, args.edition)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        document = GuideDoc(str(args.output))
        document.multiBuild(story, maxPasses=5)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"Guide build failed: {exc}", file=sys.stderr)
        return 1
    print(f"Built {args.output} ({len(chapters)} chapters, {document.page} pages)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
