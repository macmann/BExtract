"""Memory-safe LLM OCR utilities for scanned PDFs.

This module converts one PDF page at a time to an image, sends that page to a
vision-capable LLM, and yields the flattened markdown text before moving on to
next page.  It intentionally avoids loading all page images into memory at once.
"""

from __future__ import annotations

import base64
import gc
from collections.abc import Iterator
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Literal

from google import genai
from openai import OpenAI
from pdf2image import convert_from_path, pdfinfo_from_path
from PIL import Image

ProviderName = Literal["gemini", "openai"]

FLATTENING_PROMPT = (
    "You are an expert OCR and document layout engine. Convert this scanned page image into clean, "
    "markdown-formatted plain text. Accurately transcribe all tables as markdown tables, maintain "
    "paragraphs, and fix any blurred characters. Output ONLY the extracted text. Do not include "
    "introductory conversational text or code blocks."
)


@dataclass(frozen=True)
class FlattenedPage:
    """OCR text emitted for a single PDF page."""

    page_number: int
    text: str


def iter_pdf_page_images(
    pdf_path: str | Path,
    *,
    dpi: int = 200,
    image_format: str = "png",
) -> Iterator[Image.Image]:
    """Yield one rendered PDF page image at a time.

    ``pdf2image.convert_from_path`` can render a full PDF into a list, which is
    unsafe for large scanned documents.  This wrapper first asks Poppler for the
    page count, then renders exactly one page per loop iteration.
    """

    pdf_path = Path(pdf_path)
    page_count = int(pdfinfo_from_path(str(pdf_path))["Pages"])

    for page_number in range(1, page_count + 1):
        images = convert_from_path(
            str(pdf_path),
            dpi=dpi,
            first_page=page_number,
            last_page=page_number,
            fmt=image_format,
            thread_count=1,
        )
        page_image = images[0]
        try:
            yield page_image
        finally:
            page_image.close()
            del page_image
            del images
            gc.collect()


def flatten_pdf_pages(
    pdf_path: str | Path,
    *,
    provider: ProviderName,
    model_name: str,
    dpi: int = 200,
    prompt: str = FLATTENING_PROMPT,
) -> Iterator[FlattenedPage]:
    """Flatten a scanned PDF into markdown text one page at a time.

    Args:
        pdf_path: Path to the scanned PDF.
        provider: Vision provider to use: ``"gemini"`` or ``"openai"``.
        model_name: Provider model name, for example ``"gemini-2.5-flash"`` or
            ``"gpt-4o"``.
        dpi: Rendering DPI passed to ``pdf2image``.
        prompt: OCR/layout prompt sent with each page image.

    Yields:
        ``FlattenedPage`` objects in PDF page order.
    """

    normalized_provider = _normalize_provider(provider)
    page_number = 0

    for page_image in iter_pdf_page_images(pdf_path, dpi=dpi):
        page_number += 1
        text = ""
        try:
            if normalized_provider == "gemini":
                text = _flatten_page_with_gemini(page_image, model_name, prompt)
            else:
                text = _flatten_page_with_openai(page_image, model_name, prompt)
        finally:
            del page_image
            gc.collect()

        yield FlattenedPage(page_number=page_number, text=text)


def flatten_pdf_to_markdown(
    pdf_path: str | Path,
    *,
    provider: ProviderName,
    model_name: str,
    dpi: int = 200,
    page_separator: str = "\n\n---\n\n",
) -> str:
    """Return a complete flattened markdown document while processing one page at a time."""

    return page_separator.join(
        page.text for page in flatten_pdf_pages(pdf_path, provider=provider, model_name=model_name, dpi=dpi)
    )


def _normalize_provider(provider: str) -> ProviderName:
    normalized_provider = provider.strip().lower()
    if normalized_provider not in {"gemini", "openai"}:
        raise ValueError("provider must be either 'gemini' or 'openai'")
    return normalized_provider  # type: ignore[return-value]


def _flatten_page_with_gemini(page_image: Image.Image, model_name: str, prompt: str) -> str:
    client = genai.Client()
    response = client.models.generate_content(model=model_name, contents=[page_image, prompt])
    return (getattr(response, "text", None) or "").strip()


def _flatten_page_with_openai(page_image: Image.Image, model_name: str, prompt: str) -> str:
    image_base64 = _image_to_base64_png(page_image)
    client = OpenAI()
    response = client.chat.completions.create(
        model=model_name,
        messages=[
            {"role": "system", "content": prompt},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Extract the text from this scanned PDF page."},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/png;base64,{image_base64}"},
                    },
                ],
            },
        ],
    )
    del image_base64
    gc.collect()
    return (response.choices[0].message.content or "").strip()


def _image_to_base64_png(page_image: Image.Image) -> str:
    buffer = BytesIO()
    try:
        page_image.save(buffer, format="PNG")
        return base64.b64encode(buffer.getvalue()).decode("utf-8")
    finally:
        buffer.close()
