import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  CURRENT_TOC_PARSE_VERSION,
  parseChapters,
  normalizeTitleLine,
} = require('../electron/utils/parse-chapters.cjs');

const withVolumes = parseChapters(`序言

第一卷 揭棺而起

第1章 序幕
正文一

第 2 章 风起
正文二
第二卷 战火年代

第１３７９章 天文台
正文三`);

assert.equal(withVolumes.volumes.length, 2);
assert.equal(withVolumes.chapters.length, 3);
assert.equal(withVolumes.volumes[0].title, '第一卷 揭棺而起');
assert.deepEqual(withVolumes.volumes[0].chapterIds, ['chapter-1', 'chapter-2']);
assert.equal(withVolumes.volumes[1].title, '第二卷 战火年代');
assert.deepEqual(withVolumes.volumes[1].chapterIds, ['chapter-3']);
assert.equal(withVolumes.chapters[0].title, '第1章 序幕');
assert.equal(withVolumes.chapters[0].volumeId, 'volume-1');
assert.equal(withVolumes.chapters[1].title, '第 2 章 风起');
assert.equal(withVolumes.chapters[2].title, '第1379章 天文台');
assert.equal(typeof withVolumes.chapters[0].startIndex, 'number');
assert.equal(withVolumes.chapters[0].endIndex, withVolumes.chapters[1].startIndex);
assert.equal(withVolumes.tocParseVersion, CURRENT_TOC_PARSE_VERSION);

const variants = parseChapters(`    第1379章 天文台
正文
　　第1379章 天文台
正文
第　1379　章　天文台
正文
第一章 苏醒
正文
第一百二十章 远行
正文
Chapter 12 The Tower
正文
第1节 标题
正文
第1回 标题
正文
序章
正文
番外 第 1 章
正文
001. 标题
正文`);

assert.equal(variants.chapters.length, 11);
assert.deepEqual(
  variants.debug.sampleMatchedChapterTitles.slice(0, 6),
  [
    '第1379章 天文台',
    '第1379章 天文台',
    '第 1379 章 天文台',
    '第一章 苏醒',
    '第一百二十章 远行',
    'Chapter 12 The Tower',
  ]
);

const volumeForms = parseChapters(`卷一 黎明之剑
第1章 开始
第1部 山河
第2章 继续
Part 3 Future
Chapter 3 End
Volume 4 After
Chapter 4 Again`);

assert.equal(volumeForms.volumes.length, 4);
assert.equal(volumeForms.chapters.length, 4);
assert.deepEqual(volumeForms.volumes.map((volume) => volume.chapterIds.length), [1, 1, 1, 1]);

const falsePositiveText = `“第五期第三章第四条。”
他说：“你看到第十二章了吗？”
根据第三章第四节的规定……
第五期第三章第四条。
我读到了第1379章，但是还没看完。
这是第1379章里最重要的一句话。
第十二章规定了相关事项。`;

const falsePositives = parseChapters(falsePositiveText);
assert.equal(falsePositives.chapters.length, 0);
assert.ok(falsePositives.debug.rejectedFalsePositiveCandidates.includes('第五期第三章第四条。'));
assert.ok(falsePositives.debug.rejectedFalsePositiveCandidates.includes('我读到了第1379章，但是还没看完。'));

const noCatalog = parseChapters(`这是一段正文，里面提到了第一章，但不是独占一行。`);

assert.equal(noCatalog.volumes.length, 0);
assert.equal(noCatalog.chapters.length, 0);

const punctuationChapterText = [
  '第一百七十一章 谁不对呢？',
  '第一百七十二章 怎么会这样！',
  '第一百七十三章 结束了吗。',
  '第一百七十四章 “你是谁？”',
  '第一百七十五章 ——新的开始',
  '第一百七十六章',
  '第171章 谁不对呢？',
  '第 171 章 谁不对呢？',
  '第１７１章 谁不对呢？',
  '　　第一百七十一章 谁不对呢？',
  'Chapter 171 Who is wrong?',
  'CHAPTER 171 Who is wrong?',
].join('\n正文\n');

const punctuationChapters = parseChapters(punctuationChapterText);
assert.deepEqual(
  punctuationChapters.chapters.map((chapter) => chapter.title),
  [
    '第一百七十一章 谁不对呢？',
    '第一百七十二章 怎么会这样！',
    '第一百七十三章 结束了吗。',
    '第一百七十四章 “你是谁？”',
    '第一百七十五章 ——新的开始',
    '第一百七十六章',
    '第171章 谁不对呢？',
    '第 171 章 谁不对呢？',
    '第171章 谁不对呢？',
    '第一百七十一章 谁不对呢？',
    'Chapter 171 Who is wrong?',
    'CHAPTER 171 Who is wrong?',
  ]
);

const requiredFalsePositiveText = [
  '他说：“第一百七十一章 谁不对呢？”',
  '我已经看到第一百七十一章了。',
  '根据第一百七十一章第三条规定执行。',
  '第五期第三章第四条。',
  '这是第一百七十一章中最关键的一段。',
  '“第五期第三章第四条。”',
  '第一百七十一章里写了很多内容。',
].join('\n');

const requiredFalsePositives = parseChapters(requiredFalsePositiveText);
assert.equal(requiredFalsePositives.chapters.length, 0);

assert.equal(normalizeTitleLine('\uFEFF第　１７１　章\t谁不对呢？'), '第 171 章 谁不对呢？');

console.log('Chapter parser tests passed');
console.log(`Detected volumes: ${withVolumes.debug.detectedVolumes}`);
console.log(`Detected chapters: ${withVolumes.debug.detectedChapters + variants.debug.detectedChapters}`);
console.log('Rejected false-positive candidates:');
for (const candidate of falsePositives.debug.rejectedFalsePositiveCandidates.slice(0, 3)) {
  console.log(`- ${candidate}`);
}
console.log('Sample matched chapter titles:');
for (const title of variants.debug.sampleMatchedChapterTitles.slice(0, 3)) {
  console.log(`- ${title}`);
}
