const CURRENT_TOC_PARSE_VERSION = 3;

const CHINESE_NUMBER_CHARS = '零〇一二三四五六七八九十百千万亿两壹贰叁肆伍陆柒捌玖拾佰仟';
const ORDINAL_PATTERN = `[0-9${CHINESE_NUMBER_CHARS}]+`;
const TITLE_SEPARATOR_PATTERN = String.raw`(?:\s*[：:、.．\-—]+\s*|\s+|$)`;
const SENTENCE_END_PATTERN = /[。！？!?，,；;、]$/;
const QUOTE_START_PATTERN = /^[“"「『]/;
const DIALOGUE_PATTERN = /[：:][“"「『]/;
const ARTICLE_REFERENCE_PATTERN = new RegExp(
  `第\\s*${ORDINAL_PATTERN}\\s*期.*第\\s*${ORDINAL_PATTERN}\\s*章.*第\\s*${ORDINAL_PATTERN}\\s*条`
);
const CLAUSE_REFERENCE_PATTERN = new RegExp(
  `第\\s*${ORDINAL_PATTERN}\\s*章.*第\\s*${ORDINAL_PATTERN}\\s*[条款项]`
);
const CONTAINS_CHAPTER_WORD_PATTERN = new RegExp(
  `第\\s*${ORDINAL_PATTERN}\\s*[章节回话節幕]|chapter\\s+[0-9]+`,
  'i'
);

const volumePatterns = [
  new RegExp(`^第\\s*(${ORDINAL_PATTERN})\\s*[卷部]${TITLE_SEPARATOR_PATTERN}(.{0,50})$`, 'i'),
  new RegExp(`^卷\\s*(${ORDINAL_PATTERN})${TITLE_SEPARATOR_PATTERN}(.{0,50})$`, 'i'),
  new RegExp(`^(?:part|volume)\\s+(${ORDINAL_PATTERN})${TITLE_SEPARATOR_PATTERN}(.{0,50})$`, 'i'),
];

const CHINESE_CHAPTER_PATTERN = new RegExp(
  `^第\\s*(${ORDINAL_PATTERN})\\s*[章节回话節节幕]${TITLE_SEPARATOR_PATTERN}(.{0,60})$`,
  'i'
);
const ENGLISH_CHAPTER_PATTERN = /^chapter\s+([0-9]+|[ivxlcdm]+)(?:\s*[：:、.．\-—]+\s*|\s+|$)(.{0,80})$/i;

const chapterPatterns = [
  CHINESE_CHAPTER_PATTERN,
  new RegExp(`^章节\\s*(${ORDINAL_PATTERN})${TITLE_SEPARATOR_PATTERN}(.{0,40})$`, 'i'),
  ENGLISH_CHAPTER_PATTERN,
  /^(序章|楔子|前言|引子|尾声|后记|终章)(?:\s*[：:、.．\-—]+\s*|\s+|$)(.{0,40})$/i,
  new RegExp(
    `^(?:番外|外传|特典|特别篇)(?:\\s*[${CHINESE_NUMBER_CHARS}0-9]+)?(?:\\s*第\\s*${ORDINAL_PATTERN}\\s*章)?${TITLE_SEPARATOR_PATTERN}(.{0,40})$`,
    'i'
  ),
  /^[0-9]{1,4}[.、．]\s+(.{1,40})$/,
  /^[0-9]{1,4}\s+(.{1,30})$/,
];

function normalizeTitleLine(line) {
  return line
    .replace(/^\uFEFF/, '')
    .replace(/\u3000/g, ' ')
    .replace(/\t/g, ' ')
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, ' ')
    .trim();
}

function getLinesWithOffsets(text) {
  const lines = [];
  const linePattern = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let match;
  let lineNumber = 1;

  while ((match = linePattern.exec(text)) !== null) {
    if (match[0] === '') {
      break;
    }

    lines.push({
      text: match[1],
      startIndex: match.index,
      lineNumber,
    });
    lineNumber += 1;
  }

  return lines;
}

function isLikelyTitleLine(normalizedLine) {
  if (!normalizedLine) return false;
  if (normalizedLine.length > 80) return false;
  if (QUOTE_START_PATTERN.test(normalizedLine)) return false;
  if (DIALOGUE_PATTERN.test(normalizedLine)) return false;
  if (ARTICLE_REFERENCE_PATTERN.test(normalizedLine)) return false;
  if (CLAUSE_REFERENCE_PATTERN.test(normalizedLine)) return false;
  return true;
}

function isLikelyNumericTitle(normalizedLine) {
  if (normalizedLine.length > 36) return false;
  if (SENTENCE_END_PATTERN.test(normalizedLine)) return false;
  return true;
}

function matchesVolumeTitle(normalizedLine) {
  if (!isLikelyTitleLine(normalizedLine)) return false;
  return volumePatterns.some((pattern) => pattern.test(normalizedLine));
}

function matchesChapterTitle(normalizedLine) {
  if (!isLikelyTitleLine(normalizedLine)) return false;

  return chapterPatterns.some((pattern) => {
    if (!pattern.test(normalizedLine)) return false;
    if (/^[0-9]/.test(normalizedLine)) {
      return isLikelyNumericTitle(normalizedLine);
    }
    return true;
  });
}

function parseChapters(content) {
  const chapters = [];
  const volumes = [];
  const toc = [];
  const rejectedFalsePositiveCandidates = [];
  const sampleMatchedChapterTitles = [];
  let currentVolumeId;

  for (const line of getLinesWithOffsets(content)) {
    const title = normalizeTitleLine(line.text);

    if (!title) {
      continue;
    }

    if (matchesVolumeTitle(title)) {
      const volume = {
        id: `volume-${volumes.length + 1}`,
        title,
        startIndex: line.startIndex,
        lineNumber: line.lineNumber,
        chapterIds: [],
      };

      volumes.push(volume);
      toc.push({
        id: volume.id,
        type: 'volume',
        title: volume.title,
        startIndex: volume.startIndex,
        lineNumber: volume.lineNumber,
        chapterIds: volume.chapterIds,
      });
      currentVolumeId = volume.id;
      continue;
    }

    if (matchesChapterTitle(title)) {
      const chapter = {
        id: `chapter-${chapters.length + 1}`,
        title,
        volumeId: currentVolumeId,
        startIndex: line.startIndex,
        endIndex: null,
        lineNumber: line.lineNumber,
      };

      chapters.push(chapter);
      toc.push({
        id: chapter.id,
        type: 'chapter',
        title: chapter.title,
        startIndex: chapter.startIndex,
        lineNumber: chapter.lineNumber,
        volumeId: chapter.volumeId,
      });

      if (sampleMatchedChapterTitles.length < 10) {
        sampleMatchedChapterTitles.push(title);
      }

      if (currentVolumeId) {
        const volume = volumes.find((item) => item.id === currentVolumeId);
        if (volume) {
          volume.chapterIds.push(chapter.id);
        }
      }

      continue;
    }

    if (rejectedFalsePositiveCandidates.length < 20 && CONTAINS_CHAPTER_WORD_PATTERN.test(title)) {
      rejectedFalsePositiveCandidates.push(title);
    }
  }

  for (let index = 0; index < chapters.length; index += 1) {
    chapters[index].endIndex = chapters[index + 1]?.startIndex ?? content.length;
  }

  return {
    chapters,
    volumes,
    toc,
    tocParseVersion: CURRENT_TOC_PARSE_VERSION,
    debug: {
      detectedVolumes: volumes.length,
      detectedChapters: chapters.length,
      rejectedFalsePositiveCandidates,
      sampleMatchedChapterTitles,
    },
  };
}

module.exports = {
  CURRENT_TOC_PARSE_VERSION,
  CHINESE_CHAPTER_PATTERN,
  ENGLISH_CHAPTER_PATTERN,
  normalizeTitleLine,
  parseChapters,
};
