// 티스토리 각주 변환기 - MathJax 관련 유닛 테스트
// Node.js에서 실행: node test-mathjax.js

(function () {
  'use strict';

  var passed = 0;
  var failed = 0;

  function assert(condition, testName) {
    if (condition) {
      passed++;
      console.log('  ✓ ' + testName);
    } else {
      failed++;
      console.log('  ✗ ' + testName);
    }
  }

  function assertEqual(actual, expected, testName) {
    if (actual === expected) {
      passed++;
      console.log('  ✓ ' + testName);
    } else {
      failed++;
      console.log('  ✗ ' + testName);
      console.log('    expected: ' + JSON.stringify(expected));
      console.log('    actual:   ' + JSON.stringify(actual));
    }
  }

  // ─── 테스트 대상 함수 복제 ───

  function stripProtectedZones(html) {
    var zones = [];
    var idx = 0;
    var cleaned = html.replace(
      /(<pre[^>]*>[\s\S]*?<\/pre>|<code[^>]*>[\s\S]*?<\/code>|<!--[\s\S]*?-->)/gi,
      function (match) {
        var placeholder = '\x00PZ' + (idx++) + '\x00';
        zones.push({ placeholder: placeholder, content: match });
        return placeholder;
      }
    );
    return { cleaned: cleaned, zones: zones };
  }

  function restoreProtectedZones(html, zones) {
    for (var i = 0; i < zones.length; i++) {
      html = html.split(zones[i].placeholder).join(zones[i].content);
    }
    return html;
  }

  function looksLikeMath(content) {
    if (/[\\^_{}]/.test(content)) return true;
    var kw = /(?:frac|sqrt|sum|prod|int|lim|alpha|beta|gamma|delta|theta|lambda|sigma|pi|infty|partial|nabla|cdot|times|div|pm|leq|geq|neq|approx|equiv|sim|text|mathbb|overline|vec|dot|bar|begin|end|matrix)/i;
    if (kw.test(content)) return true;
    return false;
  }

  function needsMath(html) {
    var result = stripProtectedZones(html);
    var cleaned = result.cleaned;
    cleaned = cleaned.replace(/<script[\s\S]*?<\/script>/gi, '');
    if (/\$\$[\s\S]+?\$\$/.test(cleaned)) return true;
    if (/\$[^$\n]+?\$/.test(cleaned)) return true;
    if (/\\\([\s\S]+?\\\)/.test(cleaned)) return true;
    if (/\\\[[\s\S]+?\\\]/.test(cleaned)) return true;
    return false;
  }

  function alreadyHasMath(html) {
    if (/MathJax/i.test(html)) return true;
    if (/katex/i.test(html)) return true;
    if (/tex-mml-chtml/i.test(html)) return true;
    if (/__mathjaxInjected/.test(html)) return true;
    return false;
  }

  function countMathExpressions(html) {
    var result = stripProtectedZones(html);
    var cleaned = result.cleaned;
    cleaned = cleaned.replace(/<script[\s\S]*?<\/script>/gi, '');
    var display = (cleaned.match(/\$\$[\s\S]+?\$\$/g) || []).length;
    var temp = cleaned.replace(/\$\$[\s\S]+?\$\$/g, '');
    var inline = 0;
    var re = /\$([^$\n]+?)\$/g;
    var m;
    while ((m = re.exec(temp)) !== null) {
      if (looksLikeMath(m[1])) inline++;
    }
    return { display: display, inline: inline, total: display + inline };
  }

  function escapeCurrencyDollars(html) {
    var result = stripProtectedZones(html);
    var text = result.cleaned;
    var zones = result.zones;
    var escapeCount = 0;

    var scriptZones = [];
    var szIdx = 0;
    text = text.replace(/<script[\s\S]*?<\/script>/gi, function (m) {
      var ph = '\x00SZ' + (szIdx++) + '\x00';
      scriptZones.push({ ph: ph, content: m });
      return ph;
    });

    var mathZones = [];
    var mzIdx = 0;
    text = text.replace(/\$\$([\s\S]+?)\$\$/g, function (m) {
      var ph = '\x00MZ' + (mzIdx++) + '\x00';
      mathZones.push({ ph: ph, content: m });
      return ph;
    });

    text = text.replace(/\$([^$\n]+?)\$/g, function (match, content) {
      if (looksLikeMath(content)) {
        var ph = '\x00MZ' + (mzIdx++) + '\x00';
        mathZones.push({ ph: ph, content: match });
        return ph;
      }
      return match;
    });

    text = text.replace(/(?<!\\)\$(?=\d)/g, function () {
      escapeCount++;
      return '\\$';
    });

    for (var i = 0; i < mathZones.length; i++) {
      text = text.split(mathZones[i].ph).join(mathZones[i].content);
    }
    for (var j = 0; j < scriptZones.length; j++) {
      text = text.split(scriptZones[j].ph).join(scriptZones[j].content);
    }
    text = restoreProtectedZones(text, zones);

    return { escaped: text, escapeCount: escapeCount };
  }

  // ─── needsMath() 테스트 ───

  console.log('\n=== needsMath() ===');

  assert(needsMath('<p>$x^2 + y^2$</p>'), 'inline math $x^2$');
  assert(needsMath('<p>$$\\frac{a}{b}$$</p>'), 'display math $$...$$');
  assert(needsMath('<p>\\(x+y\\)</p>'), 'LaTeX \\(...\\)');
  assert(needsMath('<p>\\[x+y\\]</p>'), 'LaTeX \\[...\\]');
  assert(!needsMath('<p>일반 텍스트</p>'), 'plain text');
  assert(!needsMath('<p>가격은 5달러</p>'), 'no dollar sign');
  assert(!needsMath('<code>$x^2$</code>'), 'math inside code tag');
  assert(!needsMath('<pre>$x^2$</pre>'), 'math inside pre tag');
  assert(!needsMath('<!-- $x^2$ -->'), 'math inside comment');
  assert(!needsMath('<script>var x = $("test");</script>'), 'dollar in script tag');

  // ─── alreadyHasMath() 테스트 ───

  console.log('\n=== alreadyHasMath() ===');

  assert(alreadyHasMath('<script src="MathJax.js"></script>'), 'MathJax script');
  assert(alreadyHasMath('<link rel="stylesheet" href="katex.min.css">'), 'KaTeX CSS');
  assert(alreadyHasMath('<script src="tex-mml-chtml.js"></script>'), 'tex-mml-chtml');
  assert(alreadyHasMath('<script>window.__mathjaxInjected=true;</script>'), '__mathjaxInjected guard');
  assert(!alreadyHasMath('<p>$x^2$</p>'), 'no math library');
  assert(!alreadyHasMath('<p>일반 텍스트</p>'), 'plain text');

  // ─── looksLikeMath() 테스트 ───

  console.log('\n=== looksLikeMath() ===');

  assert(looksLikeMath('x^2'), 'caret');
  assert(looksLikeMath('V_{DS}'), 'underscore + braces');
  assert(looksLikeMath('\\frac{a}{b}'), 'backslash command');
  assert(!looksLikeMath('a + b'), 'simple a + b is not math');
  assert(!looksLikeMath('100'), 'pure number');
  assert(!looksLikeMath('hello world'), 'plain words');
  assert(looksLikeMath('\\alpha + \\beta'), 'Greek letters');
  assert(looksLikeMath('10^{-9}'), 'scientific notation');

  // ─── countMathExpressions() 테스트 ───

  console.log('\n=== countMathExpressions() ===');

  var c1 = countMathExpressions('<p>$x^2$ and $$\\frac{a}{b}$$</p>');
  assertEqual(c1.inline, 1, 'inline count = 1');
  assertEqual(c1.display, 1, 'display count = 1');
  assertEqual(c1.total, 2, 'total = 2');

  var c2 = countMathExpressions('<p>no math here</p>');
  assertEqual(c2.total, 0, 'no math total = 0');

  var c3 = countMathExpressions('<p>$x^2$ $V_{DS}$ $$E=mc^2$$</p>');
  assertEqual(c3.inline, 2, 'two inline');
  assertEqual(c3.display, 1, 'one display');

  // ─── escapeCurrencyDollars() 테스트 ───

  console.log('\n=== escapeCurrencyDollars() ===');

  // 수식 인라인 유지
  var e1 = escapeCurrencyDollars('<p>$x^2 + y^2$</p>');
  assertEqual(e1.escaped, '<p>$x^2 + y^2$</p>', 'inline math preserved');
  assertEqual(e1.escapeCount, 0, 'no escape for math');

  // 수식 디스플레이 유지
  var e2 = escapeCurrencyDollars('<p>$$\\frac{a}{b}$$</p>');
  assertEqual(e2.escaped, '<p>$$\\frac{a}{b}$$</p>', 'display math preserved');
  assertEqual(e2.escapeCount, 0, 'no escape for display math');

  // 통화 이스케이프
  var e3 = escapeCurrencyDollars('<p>비용 $5</p>');
  assertEqual(e3.escaped, '<p>비용 \\$5</p>', 'currency escaped');
  assertEqual(e3.escapeCount, 1, 'one escape');

  // 수식 + 통화 혼합
  var e4 = escapeCurrencyDollars('<p>$x^2$ costs $5</p>');
  assertEqual(e4.escaped, '<p>$x^2$ costs \\$5</p>', 'math kept, currency escaped');
  assertEqual(e4.escapeCount, 1, 'one escape in mixed');

  // 이미 이스케이프된 달러
  var e5 = escapeCurrencyDollars('<p>\\$5</p>');
  assertEqual(e5.escaped, '<p>\\$5</p>', 'already escaped preserved');
  assertEqual(e5.escapeCount, 0, 'no double escape');

  // 코드 블록 내 보호
  var e6 = escapeCurrencyDollars('<code>$5</code>');
  assertEqual(e6.escaped, '<code>$5</code>', 'code block protected');
  assertEqual(e6.escapeCount, 0, 'no escape in code');

  // 숫자로 시작하는 수식 (지시자 있음)
  var e7 = escapeCurrencyDollars('<p>$10^{-9}$</p>');
  assertEqual(e7.escaped, '<p>$10^{-9}$</p>', 'math starting with digit preserved');
  assertEqual(e7.escapeCount, 0, 'no escape for digit-start math');

  // 수식만 있고 통화 없음
  var e8 = escapeCurrencyDollars('<p>$V_{DS}$만 사용</p>');
  assertEqual(e8.escaped, '<p>$V_{DS}$만 사용</p>', 'math only preserved');
  assertEqual(e8.escapeCount, 0, 'no escape');

  // 여러 통화
  var e9 = escapeCurrencyDollars('<p>$5 and $10</p>');
  // Note: $5 and $ might match as pair first, but since no LaTeX indicators, it stays
  // Then Pass 3 escapes $ before digits
  assertEqual(e9.escapeCount > 0, true, 'multiple currencies escaped');

  // 스크립트 태그 내 보호
  var e10 = escapeCurrencyDollars('<script>var x = $5;</script>');
  assertEqual(e10.escaped, '<script>var x = $5;</script>', 'script tag protected');
  assertEqual(e10.escapeCount, 0, 'no escape in script');

  // ─── 결과 ───

  console.log('\n=== 결과 ===');
  console.log('통과: ' + passed + ', 실패: ' + failed);
  if (failed > 0) {
    console.log('⚠ 실패한 테스트가 있습니다!');
    process.exit(1);
  } else {
    console.log('✓ 모든 테스트 통과!');
  }
})();
