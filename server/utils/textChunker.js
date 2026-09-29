const MAX_CHARS = 220;

function chunkText(text, maxChars = MAX_CHARS) {
  const chunks = [];
  const paragraphs = String(text).replace(/\r\n/g, "\n").split(/\n+/);
  for (const paragraph of paragraphs) {
    const sentences = paragraph.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) || [];
    let buffer = "";
    for (const sentence of sentences) {
      const part = sentence.trim();
      if (!part) continue;
      const candidate = `${buffer} ${part}`.trim();
      if (buffer && candidate.length > maxChars) {
        chunks.push(buffer);
        buffer = part;
      } else {
        buffer = candidate;
      }
      while (buffer.length > maxChars) {
        let cut = buffer.lastIndexOf(" ", maxChars);
        if (cut < Math.floor(maxChars * 0.6)) cut = maxChars;
        chunks.push(buffer.slice(0, cut).trim());
        buffer = buffer.slice(cut).trim();
      }
    }
    if (buffer) chunks.push(buffer);
  }
  return chunks.length ? chunks : (String(text).match(new RegExp(`.{1,${maxChars}}`, "g")) || []);
}

module.exports = { chunkText };
