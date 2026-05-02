// File type-appropriate chunking strategies.
// All chunks: ~500 tokens (≈2000 chars) with 50-token overlap (≈200 chars).

const CHUNK_SIZE_CHARS = 2000;
const OVERLAP_CHARS = 200;
const SLIDE_SEPARATOR = /\[Slide \d+\]/;

export function chunkByFileType(content: string, fileType: string): string[] {
  const type = fileType.toLowerCase().replace(".", "");

  switch (type) {
    case "docx":
    case "doc":
    case "pdf":
    case "md":
    case "markdown":
    case "txt":
    case "rtf":
      return chunkByStructure(content);

    case "xlsx":
    case "xls":
    case "csv":
    case "tsv":
      return chunkByRows(content, 30);

    case "pptx":
    case "ppt":
      return chunkBySlide(content);

    case "py":
    case "js":
    case "ts":
    case "tsx":
    case "jsx":
    case "java":
    case "cpp":
    case "c":
    case "h":
    case "hpp":
    case "cs":
    case "go":
    case "rs":
    case "rb":
    case "php":
    case "swift":
    case "kt":
      return chunkByCodeStructure(content);

    case "html":
    case "htm":
    case "xml":
      return chunkByStructure(content);

    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
      // Single chunk containing the AI-generated description
      return content ? [content] : [];

    default:
      return chunkFixed(content, CHUNK_SIZE_CHARS, OVERLAP_CHARS);
  }
}

// Structure-aware chunking: split on headings and paragraph breaks
function chunkByStructure(content: string): string[] {
  if (!content.trim()) return [];

  // Split on heading patterns or double newlines
  const sections = content.split(/(?=^#{1,4}\s|\n\n---|\n\n)/m).filter((s) => s.trim());

  if (sections.length <= 1) {
    return chunkFixed(content, CHUNK_SIZE_CHARS, OVERLAP_CHARS);
  }

  const chunks: string[] = [];
  let current = "";

  for (const section of sections) {
    if (current.length + section.length <= CHUNK_SIZE_CHARS) {
      current += (current ? "\n\n" : "") + section;
    } else {
      if (current.trim()) chunks.push(current.trim());
      // If section itself is too large, split it further
      if (section.length > CHUNK_SIZE_CHARS) {
        chunks.push(...chunkFixed(section, CHUNK_SIZE_CHARS, OVERLAP_CHARS));
        current = "";
      } else {
        current = section;
      }
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks.filter((c) => c.length > 50);
}

// Row-level chunking for spreadsheets.
// Splits on sheet boundaries ("--- Sheet: NAME ... ---") and repeats the
// column-header row on every chunk so each chunk is self-describing for retrieval.
function chunkByRows(content: string, rowsPerChunk: number): string[] {
  if (!content.trim()) return [];

  // Split on sheet header markers but keep them attached to their block.
  // Matches headers produced by the extractor: "--- Sheet: NAME (N rows) ---"
  // and the simpler "--- CSV ---" / "--- TSV ---" forms.
  const sheetHeaderRe = /^--- (?:Sheet: .+?|CSV|TSV)(?: \(\d+ rows\))? ---$/m;
  const blocks: { header: string; body: string }[] = [];

  const lines = content.split("\n");
  let currentHeader = "";
  let currentBody: string[] = [];

  const flush = () => {
    if (currentHeader || currentBody.length) {
      blocks.push({ header: currentHeader, body: currentBody.join("\n") });
    }
  };

  for (const line of lines) {
    if (sheetHeaderRe.test(line)) {
      flush();
      currentHeader = line;
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  flush();

  // No sheet markers found — treat the whole content as one block.
  if (!blocks.length) blocks.push({ header: "", body: content });

  const chunks: string[] = [];

  for (const { header, body } of blocks) {
    const rows = body.split("\n").filter((l) => l.trim().length > 0);
    if (!rows.length) continue;

    // First non-empty row is treated as the column header so it can be
    // repeated in every chunk for context. This preserves column meaning
    // across row batches and is critical for accurate retrieval.
    const columnHeader = rows[0];
    const dataRows = rows.slice(1);

    // If a sheet has only a header row, still emit a chunk for it.
    if (!dataRows.length) {
      const chunk = [header, columnHeader].filter(Boolean).join("\n");
      if (chunk.trim()) chunks.push(chunk.trim());
      continue;
    }

    for (let i = 0; i < dataRows.length; i += rowsPerChunk) {
      const batch = dataRows.slice(i, i + rowsPerChunk);
      const rangeNote = `Rows ${i + 1}-${Math.min(i + rowsPerChunk, dataRows.length)} of ${dataRows.length}`;
      const chunk = [
        header,
        rangeNote,
        columnHeader,
        ...batch,
      ]
        .filter(Boolean)
        .join("\n");
      if (chunk.trim()) chunks.push(chunk.trim());
    }
  }

  return chunks.length ? chunks : chunkFixed(content, CHUNK_SIZE_CHARS, OVERLAP_CHARS);
}

// One chunk per slide for presentations
function chunkBySlide(content: string): string[] {
  const slideBlocks = content.split(SLIDE_SEPARATOR).filter((s) => s.trim());
  const chunks: string[] = [];

  slideBlocks.forEach((block, i) => {
    const slideText = `[Slide ${i + 1}]\n${block.trim()}`;
    if (slideText.length <= CHUNK_SIZE_CHARS * 1.5) {
      chunks.push(slideText);
    } else {
      // Slide too long (e.g., lots of speaker notes) — split it
      chunks.push(...chunkFixed(slideText, CHUNK_SIZE_CHARS, OVERLAP_CHARS));
    }
  });

  return chunks;
}

// Code: function/class-level chunking
function chunkByCodeStructure(content: string): string[] {
  if (!content.trim()) return [];

  // Split on function/class definitions
  const topLevelPattern = /^(?:(?:export\s+)?(?:async\s+)?function\s|(?:export\s+)?class\s|def\s|public\s+(?:static\s+)?(?:class|void|String|int)\s)/m;

  const blocks: string[] = [];
  const lines = content.split("\n");
  let current: string[] = [];
  let depth = 0;

  for (const line of lines) {
    const braceOpen = (line.match(/{/g) ?? []).length;
    const braceClose = (line.match(/}/g) ?? []).length;

    current.push(line);
    depth += braceOpen - braceClose;

    // At top-level boundaries (depth returns to 0 after a block)
    if (depth <= 0 && current.length > 5) {
      const block = current.join("\n").trim();
      if (block) blocks.push(block);
      current = [];
      depth = 0;
    }

    // Safety: don't let a single accumulation grow too large
    if (current.join("\n").length > CHUNK_SIZE_CHARS * 2) {
      const block = current.join("\n").trim();
      if (block) blocks.push(block);
      current = [];
      depth = 0;
    }
  }

  if (current.join("\n").trim()) blocks.push(current.join("\n").trim());

  if (!blocks.length) return chunkFixed(content, CHUNK_SIZE_CHARS, OVERLAP_CHARS);

  // Merge very small blocks with the next
  const merged: string[] = [];
  let acc = "";
  for (const block of blocks) {
    if (acc.length + block.length < CHUNK_SIZE_CHARS) {
      acc += (acc ? "\n\n" : "") + block;
    } else {
      if (acc) merged.push(acc);
      acc = block.length > CHUNK_SIZE_CHARS
        ? (chunkFixed(block, CHUNK_SIZE_CHARS, OVERLAP_CHARS).shift() ?? block)
        : block;
    }
  }
  if (acc) merged.push(acc);

  return merged.filter((c) => c.length > 20);
}

// Fixed-size chunking with overlap
function chunkFixed(text: string, size: number, overlap: number): string[] {
  if (!text.trim()) return [];
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = start + size;
    chunks.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = end - overlap;
  }

  return chunks.filter((c) => c.length > 20);
}
