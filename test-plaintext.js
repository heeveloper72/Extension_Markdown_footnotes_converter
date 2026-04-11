// 평문 [N] 각주 변환 테스트
// 티스토리가 [^N] 마크다운을 [N]으로 변환한 경우를 시뮬레이션

// ─── content.js에서 필요한 함수만 추출 ───

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripProtectedZones(html) {
  const zones = [];
  let idx = 0;
  const cleaned = html.replace(
    /(<pre[^>]*>[\s\S]*?<\/pre>|<code[^>]*>[\s\S]*?<\/code>|<!--[\s\S]*?-->)/gi,
    (match) => {
      const placeholder = '\x00PZ' + (idx++) + '\x00';
      zones.push({ placeholder, content: match });
      return placeholder;
    }
  );
  return { cleaned, zones };
}

function restoreProtectedZones(html, zones) {
  for (const { placeholder, content } of zones) {
    html = html.split(placeholder).join(content);
  }
  return html;
}

function detectPlainTextCluster(html) {
  var defRe = /<p[^>]*>\[(\d+)\]\s{2,}/g;
  var defs = [];
  var m;
  while ((m = defRe.exec(html)) !== null) {
    var num = parseInt(m[1], 10);
    var afterIdx = m.index + m[0].length;
    var rest = html.substring(afterIdx);
    var pEnd = rest.indexOf('</p>');
    var rawContent = pEnd >= 0 ? rest.substring(0, pEnd) : rest.substring(0, 100);
    var content = rawContent.replace(/<[^>]*>/g, '').trim();
    defs.push({ num: num, index: m.index, content: content });
  }

  if (defs.length < 2) return null;

  var docLen = html.length;
  var clusterStart = defs[0].index;
  if (clusterStart < docLen * 0.3) return null;

  var numbers = new Set();
  for (var i = 0; i < defs.length; i++) {
    numbers.add(defs[i].num);
  }
  var maxNum = 0;
  numbers.forEach(function (n) { if (n > maxNum) maxNum = n; });

  var missing = [];
  for (var n = 1; n <= maxNum; n++) {
    if (!numbers.has(n)) missing.push(n);
  }
  if (missing.length > maxNum * 0.2) return null;

  var definitions = new Map();
  for (var j = 0; j < defs.length; j++) {
    definitions.set(defs[j].num, { index: defs[j].index, content: defs[j].content });
  }

  return { definitions: definitions, clusterStart: clusterStart, numbers: numbers, maxNum: maxNum, missing: missing };
}

function detectPlainTextPairs(html) {
  var result = stripProtectedZones(html);
  var cleaned = result.cleaned;

  var cluster = detectPlainTextCluster(cleaned);
  if (!cluster || cluster.definitions.size < 2) {
    return { pairs: [], alreadyProcessed: false, format: null };
  }

  if (cleaned.includes('id="_ftnref')) {
    return { pairs: [], alreadyProcessed: true, format: 'plaintext' };
  }

  var bodyArea = cleaned.substring(0, cluster.clusterStart);
  var bodyRefs = {};
  var refRe = /\[(\d+)\]/g;
  var rm;
  while ((rm = refRe.exec(bodyArea)) !== null) {
    var rNum = parseInt(rm[1], 10);
    if (!cluster.definitions.has(rNum)) continue;
    var before = bodyArea.substring(Math.max(0, rm.index - 20), rm.index);
    if (/<p[^>]*>\s*$/.test(before)) continue;

    if (!bodyRefs[rNum]) {
      var start = Math.max(0, rm.index - 30);
      var end = Math.min(bodyArea.length, rm.index + rm[0].length + 30);
      var ctx = bodyArea.substring(start, end).replace(/<[^>]*>/g, '').trim();
      bodyRefs[rNum] = { index: rm.index, context: ctx };
    }
  }

  var pairs = [];
  var nums = [];
  cluster.definitions.forEach(function (val, key) { nums.push(key); });
  nums.sort(function (a, b) { return a - b; });

  for (var i = 0; i < nums.length; i++) {
    var n = nums[i];
    var def = cluster.definitions.get(n);
    var bodyRef = bodyRefs[n];

    pairs.push({
      number: n,
      bodyContext: bodyRef ? bodyRef.context : '(본문 참조 미발견)',
      footContext: '[' + n + ']  ' + def.content,
      hasBodyRef: !!bodyRef,
    });
  }

  var orphanDefs = [];
  for (var oi = 0; oi < nums.length; oi++) {
    if (!bodyRefs[nums[oi]]) orphanDefs.push(String(nums[oi]));
  }

  return {
    pairs: pairs,
    alreadyProcessed: false,
    format: 'plaintext',
    cluster: cluster,
    orphanRefs: [],
    orphanDefs: orphanDefs,
  };
}

function convertAllPlainTextFootnotes(html, scanResult) {
  var cluster = scanResult.cluster;
  if (!cluster) return html;

  var bodyArea = html.substring(0, cluster.clusterStart);
  bodyArea = bodyArea.replace(/\[(\d+)\]/g, function (match, numStr, offset) {
    var num = parseInt(numStr, 10);
    if (!cluster.definitions.has(num)) return match;
    var before = bodyArea.substring(Math.max(0, offset - 20), offset);
    if (/<p[^>]*>\s*$/.test(before)) return match;
    return '<sup><a id="_ftnref' + num + '" href="#_ftn' + num + '">[' + num + ']</a></sup>';
  });

  var footArea = html.substring(cluster.clusterStart);
  footArea = footArea.replace(/<p([^>]*)>\[(\d+)\](\s{2,})/g, function (match, attrs, numStr, spaces) {
    var num = parseInt(numStr, 10);
    if (!cluster.definitions.has(num)) return match;
    return '<p' + attrs + '><a id="_ftn' + num + '" href="#_ftnref' + num + '">[' + num + ']</a>' + spaces;
  });

  return bodyArea + footArea;
}

function convertSinglePlainTextFootnote(html, number) {
  var n = number;
  var cluster = detectPlainTextCluster(html);
  if (!cluster) return html;

  var bodyArea = html.substring(0, cluster.clusterStart);
  var replaced = false;
  var bodyResult = bodyArea.replace(/\[(\d+)\]/g, function (match, numStr, offset) {
    if (replaced) return match;
    if (parseInt(numStr, 10) !== n) return match;
    var before = bodyArea.substring(Math.max(0, offset - 20), offset);
    if (/<p[^>]*>\s*$/.test(before)) return match;
    replaced = true;
    return '<sup><a id="_ftnref' + n + '" href="#_ftn' + n + '">[' + n + ']</a></sup>';
  });

  var footArea = html.substring(cluster.clusterStart);
  var defRe = new RegExp('<p([^>]*)>\\[' + n + '\\](\\s{2,})', 'g');
  footArea = footArea.replace(defRe, function (match, attrs, spaces) {
    return '<p' + attrs + '><a id="_ftn' + n + '" href="#_ftnref' + n + '">[' + n + ']</a>' + spaces;
  });

  return bodyResult + footArea;
}

function detectFootnoteFormat(html) {
  const { cleaned } = stripProtectedZones(html);

  const hasWord = /<a\s+href="#_ftn\d+"/.test(cleaned);
  const hasMarkdownRef = /\[\^[^\]\s]+\]/.test(cleaned);
  const hasInline = /\^\[[^\]]+\]/.test(cleaned);
  const hasMarkdown = hasMarkdownRef || hasInline;
  const hasRendered = /id="fn(?:ref)?[-_]?\d+"/.test(cleaned) || /class="footnote-ref"/.test(cleaned);

  if (hasWord && hasMarkdown) return 'mixed';
  if (hasWord) return 'word';
  if (hasMarkdown) return 'markdown';
  if (hasRendered) return 'rendered';

  var ptCluster = detectPlainTextCluster(cleaned);
  if (ptCluster && ptCluster.definitions.size >= 2) return 'plaintext';

  return null;
}

// ─── 테스트 ───

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  ✓ ' + name);
    passed++;
  } catch (e) {
    console.log('  ✗ ' + name + ': ' + e.message);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || '') + '\n  Expected: ' + JSON.stringify(expected) + '\n  Actual:   ' + JSON.stringify(actual));
  }
}

// ─── 테스트 1: 기본 클러스터 감지 ───
console.log('\n=== 평문 [N] 클러스터 감지 ===');

test('기본 클러스터 감지', function () {
  var html = '<p>본문 텍스트입니다.[1] 그리고 추가 텍스트.[2]</p>' +
    '<p>더 많은 본문입니다.[3]</p>' +
    '<hr>' +
    '<p>[1]  첫 번째 각주입니다</p>' +
    '<p>[2]  두 번째 각주입니다</p>' +
    '<p>[3]  세 번째 각주입니다</p>';
  var cluster = detectPlainTextCluster(html);
  assert(cluster !== null, '클러스터가 null');
  assertEqual(cluster.definitions.size, 3, '정의 수');
  assertEqual(cluster.maxNum, 3, '최대 번호');
  assertEqual(cluster.missing.length, 0, '빠진 번호');
});

test('단일 정의는 클러스터 아님', function () {
  var html = '<p>본문입니다.[1]</p><hr><p>[1]  각주입니다</p>';
  var cluster = detectPlainTextCluster(html);
  assert(cluster === null, '단일 정의는 거부해야 함');
});

test('문서 앞쪽에 있으면 클러스터 아님', function () {
  var html = '<p>[1]  각주1</p><p>[2]  각주2</p><p>본문이 매우 길다...</p>' +
    'x'.repeat(500);
  var cluster = detectPlainTextCluster(html);
  assert(cluster === null, '앞쪽 정의는 거부해야 함');
});

// ─── 테스트 2: 형식 감지 ───
console.log('\n=== 형식 감지 ===');

test('Word 형식 우선', function () {
  var html = '<p>본문<a href="#_ftn1">[1]</a></p><p>[1]  각주</p><p>[2]  각주2</p>';
  assertEqual(detectFootnoteFormat(html), 'word');
});

test('마크다운 형식 우선', function () {
  var html = '<p>본문[^1] 텍스트</p><p>[^1]: 각주입니다</p><p>[1]  다른거</p><p>[2]  다른거2</p>';
  assertEqual(detectFootnoteFormat(html), 'markdown');
});

test('평문 감지', function () {
  var html = '<p>본문입니다.[1] 그리고.[2]</p>' +
    '<p>더 많은 본문.[3]</p>' +
    '<hr>' +
    '<p>[1]  각주1</p>' +
    '<p>[2]  각주2</p>' +
    '<p>[3]  각주3</p>';
  assertEqual(detectFootnoteFormat(html), 'plaintext');
});

test('평문 아닌 경우 null', function () {
  var html = '<p>일반 텍스트 [1] 언급은 하지만 정의 없음</p>';
  assertEqual(detectFootnoteFormat(html), null);
});

// ─── 테스트 3: 쌍 탐지 ───
console.log('\n=== 쌍 탐지 ===');

test('기본 쌍 탐지', function () {
  var html = '<p>본문 텍스트입니다.[1] 그리고.[2]</p>' +
    '<p>더 많은 본문.[3]</p>' +
    '<hr>' +
    '<p>[1]  첫 번째 각주</p>' +
    '<p>[2]  두 번째 각주</p>' +
    '<p>[3]  세 번째 각주</p>';
  var result = detectPlainTextPairs(html);
  assertEqual(result.format, 'plaintext');
  assertEqual(result.pairs.length, 3, '쌍 수');
  assert(result.pairs[0].hasBodyRef, '[1] 본문 참조');
  assert(result.pairs[1].hasBodyRef, '[2] 본문 참조');
  assert(result.pairs[2].hasBodyRef, '[3] 본문 참조');
});

test('<p> 직후 [N]은 본문 참조로 잡지 않음', function () {
  // 정의 영역 아닌 곳에서 <p>[1] 형태는 참조가 아님
  var html = '<p>[1] 이건 목록일수도</p>' +
    '<p>본문 텍스트.[2] 본문.[3]</p>' +
    '<hr>' +
    '<p>[1]  각주1</p>' +
    '<p>[2]  각주2</p>' +
    '<p>[3]  각주3</p>';
  var result = detectPlainTextPairs(html);
  // [1]은 <p> 직후이므로 본문 참조 아님
  var pair1 = result.pairs.find(function (p) { return p.number === 1; });
  assert(!pair1.hasBodyRef, '[1] 본문 참조가 아니어야 함');
});

// ─── 테스트 4: 변환 ───
console.log('\n=== 변환 ===');

test('전체 변환', function () {
  var html = '<p>본문입니다.[1] 그리고.[2]</p>' +
    '<hr>' +
    '<p>[1]  첫째 각주</p>' +
    '<p>[2]  둘째 각주</p>';
  var scanResult = detectPlainTextPairs(html);
  var converted = convertAllPlainTextFootnotes(html, scanResult);

  // 본문 참조 변환 확인
  assert(converted.includes('id="_ftnref1"'), '본문 참조 1 id');
  assert(converted.includes('href="#_ftn1"'), '본문 참조 1 href');
  assert(converted.includes('id="_ftnref2"'), '본문 참조 2 id');

  // 정의 변환 확인
  assert(converted.includes('id="_ftn1"'), '정의 1 id');
  assert(converted.includes('href="#_ftnref1"'), '정의 1 href');
  assert(converted.includes('id="_ftn2"'), '정의 2 id');
});

test('단일 변환', function () {
  var html = '<p>본문입니다.[1] 그리고.[2]</p>' +
    '<hr>' +
    '<p>[1]  첫째 각주</p>' +
    '<p>[2]  둘째 각주</p>';

  var converted = convertSinglePlainTextFootnote(html, 1);
  assert(converted.includes('id="_ftnref1"'), '1번 변환됨');
  assert(!converted.includes('id="_ftnref2"'), '2번은 아직 변환 안 됨');
  assert(converted.includes('id="_ftn1"'), '정의 1 변환됨');
  assert(!converted.includes('id="_ftn2"'), '정의 2는 아직 변환 안 됨');
});

// ─── 테스트 5: 티스토리 실제 패턴 시뮬레이션 ───
console.log('\n=== 티스토리 실제 패턴 ===');

test('data-ke-size 속성이 있는 <p> 태그', function () {
  var html = '<p data-ke-size="size16">본문 텍스트입니다.[1] 그리고.[2]</p>' +
    '<p data-ke-size="size16">더 많은 텍스트.[3]</p>' +
    '<hr>' +
    '<p>[1]  각주 내용 1</p>' +
    '<p>[2]  각주 내용 2</p>' +
    '<p>[3]  각주 내용 3</p>';
  var result = detectPlainTextPairs(html);
  assertEqual(result.pairs.length, 3);
  var converted = convertAllPlainTextFootnotes(html, result);
  assert(converted.includes('id="_ftnref1"'), '변환 성공');
});

test('순서가 뒤바뀐 정의 (7번이 11번 뒤에)', function () {
  var body = '';
  for (var i = 1; i <= 11; i++) {
    body += '<p data-ke-size="size16">텍스트.[' + i + ']</p>';
  }
  // 정의: 1~6, 8~11 순서, 7은 마지막에
  var defs = '';
  for (var j = 1; j <= 6; j++) {
    defs += '<p>[' + j + ']  각주 ' + j + '</p>';
  }
  for (var k = 8; k <= 11; k++) {
    defs += '<p>[' + k + ']  각주 ' + k + '</p>';
  }
  defs += '<p>[7]  각주 7 (뒤늦게)</p>';

  var html = body + '<hr>' + defs;
  var cluster = detectPlainTextCluster(html);
  assert(cluster !== null, '클러스터 감지');
  assertEqual(cluster.definitions.size, 11, '11개 정의');
  assert(cluster.definitions.has(7), '7번 포함');
  assertEqual(cluster.missing.length, 0, '빠진 번호 없음');
});

test('<hr> 구분선 포함', function () {
  var html = '<p>본문.[1] 본문.[2] 본문.[3]</p>' +
    '<hr>' +
    '<p>[1]  각주1</p>' +
    '<p>[2]  각주2</p>' +
    '<p>[3]  각주3</p>';
  var result = detectPlainTextPairs(html);
  assertEqual(result.pairs.length, 3);
});

// ─── 테스트 6: Word 형식 기존 동작 보존 ───
console.log('\n=== 기존 형식 하위 호환성 ===');

test('Word 형식이 plaintext보다 우선', function () {
  var html = '<p>본문<a href="#_ftn1"><span>[1]</span></a> 텍스트<a href="#_ftn2"><span>[2]</span></a></p>' +
    '<hr>' +
    '<p>[1]  각주1</p>' +
    '<p>[2]  각주2</p>';
  assertEqual(detectFootnoteFormat(html), 'word');
});

test('마크다운 형식이 plaintext보다 우선', function () {
  var html = '<p>본문[^1] 본문[^2]</p>' +
    '<p>[^1]: 각주1</p><p>[^2]: 각주2</p>' +
    '<hr>' +
    '<p>[1]  각주1</p>' +
    '<p>[2]  각주2</p>';
  assertEqual(detectFootnoteFormat(html), 'markdown');
});

// ─── 테스트 7: code/pre 보호 ───
console.log('\n=== Protected zone ===');

test('code 내 [N] 패턴은 무시', function () {
  var html = '<p>본문.[1] 텍스트.[2]</p>' +
    '<code>[3]  이건 코드</code>' +
    '<hr>' +
    '<p>[1]  각주1</p>' +
    '<p>[2]  각주2</p>';
  var result = detectPlainTextPairs(html);
  // code 안의 [3]은 정의로 잡히지 않아야 함
  var has3 = result.pairs.some(function (p) { return p.number === 3; });
  assert(!has3, 'code 안의 [3]은 무시');
});

// ─── 테스트 8: 이미 변환된 경우 ───
console.log('\n=== 이미 변환된 경우 ===');

test('이미 변환됐으면 alreadyProcessed', function () {
  // 전체 변환 후에는 [N] 정의가 <a id="_ftn..."> 형태로 바뀌어 클러스터가 안 잡힘
  // → format null, pairs 빈 배열로 반환 (popup에서 "각주 없음"으로 처리)
  var html = '<p>본문<sup><a id="_ftnref1" href="#_ftn1">[1]</a></sup> 텍스트<sup><a id="_ftnref2" href="#_ftn2">[2]</a></sup></p>' +
    '<hr>' +
    '<p><a id="_ftn1" href="#_ftnref1">[1]</a>  각주1</p>' +
    '<p><a id="_ftn2" href="#_ftnref2">[2]</a>  각주2</p>';
  var result = detectPlainTextPairs(html);
  // 클러스터가 잡히지 않으므로 pairs 빈 배열
  assertEqual(result.pairs.length, 0, '변환된 상태에서 쌍 없음');
  // format 감지에서도 plaintext 아님
  assertEqual(detectFootnoteFormat(html), null, '변환 후 형식 null');
});

// ─── 테스트 9: 16개 각주 (사용자 실제 데이터 규모) ───
console.log('\n=== 대규모 테스트 (16 각주) ===');

test('16개 각주 전체 변환', function () {
  var body = '';
  for (var i = 1; i <= 16; i++) {
    body += '<p data-ke-size="size16">문장이 여기서 끝났다.[' + i + ']</p>';
  }
  // <hr> 구분
  var defs = '<hr>';
  for (var j = 1; j <= 6; j++) {
    defs += '<p>[' + j + ']  각주 내용 ' + j + '</p>';
  }
  for (var k = 8; k <= 11; k++) {
    defs += '<p>[' + k + ']  각주 내용 ' + k + '</p>';
  }
  defs += '<p>[7]  각주 내용 7 (순서 이상)</p>';
  for (var l = 12; l <= 16; l++) {
    defs += '<p>[' + l + ']  각주 내용 ' + l + '</p>';
  }

  var html = body + defs;
  var result = detectPlainTextPairs(html);
  assertEqual(result.format, 'plaintext');
  assertEqual(result.pairs.length, 16, '16개 쌍');

  var converted = convertAllPlainTextFootnotes(html, result);
  for (var c = 1; c <= 16; c++) {
    assert(converted.includes('id="_ftnref' + c + '"'), '본문 참조 ' + c);
    assert(converted.includes('id="_ftn' + c + '"'), '정의 ' + c);
  }
});

// ─── 결과 ───
console.log('\n=== 결과: ' + passed + ' passed, ' + failed + ' failed ===\n');
process.exit(failed > 0 ? 1 : 0);
