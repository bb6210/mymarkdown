/* ---------- 代码块语法高亮：轻量内置高亮器（不依赖第三方库） ---------- */

export interface LangItem {
  value: string;
  label: string;
}

// 语言下拉框完整列表
export const LANGUAGES: LangItem[] = [
  { value: 'text', label: '纯文本' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'jsx', label: 'JSX' },
  { value: 'tsx', label: 'TSX' },
  { value: 'html', label: 'HTML' },
  { value: 'xml', label: 'XML' },
  { value: 'svg', label: 'SVG' },
  { value: 'vue', label: 'Vue' },
  { value: 'css', label: 'CSS' },
  { value: 'scss', label: 'SCSS' },
  { value: 'less', label: 'Less' },
  { value: 'json', label: 'JSON' },
  { value: 'python', label: 'Python' },
  { value: 'java', label: 'Java' },
  { value: 'c', label: 'C' },
  { value: 'cpp', label: 'C++' },
  { value: 'csharp', label: 'C#' },
  { value: 'go', label: 'Go' },
  { value: 'rust', label: 'Rust' },
  { value: 'kotlin', label: 'Kotlin' },
  { value: 'swift', label: 'Swift' },
  { value: 'php', label: 'PHP' },
  { value: 'ruby', label: 'Ruby' },
  { value: 'sql', label: 'SQL' },
  { value: 'yaml', label: 'YAML' },
  { value: 'toml', label: 'TOML' },
  { value: 'ini', label: 'INI' },
  { value: 'bash', label: 'Bash' },
  { value: 'sh', label: 'Shell' },
  { value: 'powershell', label: 'PowerShell' },
  { value: 'bat', label: 'Batch' },
  { value: 'dockerfile', label: 'Dockerfile' },
  { value: 'makefile', label: 'Makefile' },
  { value: 'lua', label: 'Lua' },
  { value: 'r', label: 'R' },
  { value: 'dart', label: 'Dart' },
  { value: 'scala', label: 'Scala' },
  { value: 'perl', label: 'Perl' },
  { value: 'objectivec', label: 'Objective-C' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'diff', label: 'Diff' },
];

interface CodeLangCfg {
  keywords?: string[];
  lineComment?: string;
  blockComment?: [string, string];
  hashComment?: boolean;
  strings?: string[];
  funcs?: boolean;
}

const CONFIGS: Record<string, CodeLangCfg> = {
  javascript: {
    keywords: 'let const var function return if else for while do switch case break continue new class extends super this typeof instanceof in of try catch finally throw async await yield delete void import export from default static get set true false null undefined NaN Infinity'.split(' '),
    lineComment: '//',
    blockComment: ['/*', '*/'],
    strings: ['\"', '\'', '\u0060'],
    funcs: true,
  },
  typescript: {
    keywords: 'let const var function return if else for while do switch case break continue new class extends implements interface type enum namespace declare readonly private protected public abstract static get set super this typeof instanceof in of try catch finally throw async await yield delete void import export from default true false null undefined unknown never any string number boolean symbol object keyof satisfies as is'.split(' '),
    lineComment: '//',
    blockComment: ['/*', '*/'],
    strings: ['\"', '\'', '\u0060'],
    funcs: true,
  },
  python: {
    keywords: 'def return if elif else for while in not and or is None True False class import from as try except finally raise with lambda pass break continue global nonlocal yield del assert async await match case self'.split(' '),
    hashComment: true,
    strings: ['\"', '\''],
    funcs: true,
  },
  java: {
    keywords: 'public private protected static final void int long double float boolean char byte short String new return if else for while do switch case break continue class interface extends implements throws try catch finally throw this super import package abstract enum instanceof true false null native synchronized volatile transient'.split(' '),
    lineComment: '//',
    blockComment: ['/*', '*/'],
    strings: ['\"', '\''],
    funcs: true,
  },
  c: {
    keywords: 'int char float double void unsigned signed long short const struct union enum typedef static extern register return if else for while do switch case break continue goto sizeof'.split(' '),
    lineComment: '//',
    blockComment: ['/*', '*/'],
    strings: ['\"', '\''],
    funcs: true,
  },
  cpp: {
    keywords: 'int char float double void unsigned signed long short const struct union enum typedef static extern register return if else for while do switch case break continue goto sizeof class namespace template typename virtual override public private protected new delete this operator friend inline constexpr auto using true false nullptr'.split(' '),
    lineComment: '//',
    blockComment: ['/*', '*/'],
    strings: ['\"', '\''],
    funcs: true,
  },
  csharp: {
    keywords: 'public private protected internal static void int string bool double float decimal var class interface struct enum namespace using return if else for foreach while do switch case break continue new this base try catch finally throw async await task true false null override virtual abstract readonly get set'.split(' '),
    lineComment: '//',
    blockComment: ['/*', '*/'],
    strings: ['\"', '\''],
    funcs: true,
  },
  go: {
    keywords: 'package import func var const type struct interface map chan go defer return if else for range switch case default break continue select'.split(' '),
    lineComment: '//',
    blockComment: ['/*', '*/'],
    strings: ['\"', '\u0060'],
    funcs: true,
  },
  rust: {
    keywords: 'fn let mut const static struct enum trait impl mod use pub if else match loop while for in return break continue unsafe async await move ref self super dyn where'.split(' '),
    lineComment: '//',
    blockComment: ['/*', '*/'],
    strings: ['\"', '\''],
    funcs: true,
  },
  kotlin: {
    keywords: 'fun val var class object interface enum when if else for while do return break continue private public protected internal override open abstract sealed data companion init constructor try catch finally throw null true false'.split(' '),
    lineComment: '//',
    blockComment: ['/*', '*/'],
    strings: ['\"', '\''],
    funcs: true,
  },
  swift: {
    keywords: 'func var let class struct enum protocol extension import return if else guard switch case default for while repeat break continue throws try catch defer init deinit self super nil true false'.split(' '),
    lineComment: '//',
    blockComment: ['/*', '*/'],
    strings: ['\"', '\'', '\u0060'],
    funcs: true,
  },
  php: {
    keywords: 'echo print if else elseif for foreach while do switch case break continue return function class extends implements public private protected static const new try catch finally throw namespace use require require_once include include_once true false null'.split(' '),
    lineComment: '//',
    blockComment: ['/*', '*/'],
    hashComment: true,
    strings: ['\"', '\''],
    funcs: true,
  },
  ruby: {
    keywords: 'def end if elsif else unless while until for in do case when then return break next yield begin rescue ensure module class require puts true false nil self'.split(' '),
    hashComment: true,
    strings: ['\"', '\''],
    funcs: true,
  },
  sql: {
    keywords: 'select from where insert into values update set delete create table drop alter index view join inner left right outer on group by order having limit distinct as and or not null primary key foreign references default'.split(' '),
    lineComment: '--',
    blockComment: ['/*', '*/'],
    strings: ['\'', '\"'],
  },
  bash: {
    keywords: 'if then else elif fi for while do done case esac function return local export readonly set unset echo exit shift test true false'.split(' '),
    hashComment: true,
    strings: ['\"', '\'', '\u0060'],
  },
  sh: {
    keywords: 'if then else elif fi for while do done case esac function return local export readonly set unset echo exit shift test true false'.split(' '),
    hashComment: true,
    strings: ['\"', '\''],
  },
  powershell: {
    keywords: 'function param if else elseif switch foreach for while do until break continue return new get set write host exit true false null'.split(' '),
    hashComment: true,
    strings: ['\"', '\''],
  },
  bat: {
    keywords: 'echo set if else for goto call exit rem'.split(' '),
    lineComment: 'REM',
    strings: ['\"'],
  },
  yaml: {
    keywords: 'true false yes no null on off'.split(' '),
    hashComment: true,
    strings: ['\"', '\''],
  },
  toml: {
    keywords: 'true false'.split(' '),
    hashComment: true,
    strings: ['\"', '\''],
  },
  ini: {
    strings: ['\"'],
    lineComment: ';',
    hashComment: true,
  },
  json: {
    keywords: 'true false null'.split(' '),
    strings: ['\"'],
  },
  lua: {
    keywords: 'function end if then else elseif for while do repeat until return local nil true false and or not'.split(' '),
    lineComment: '--',
    blockComment: ['--[[', ']]'],
    strings: ['\"', '\''],
    funcs: true,
  },
  r: {
    keywords: 'function if else for while repeat return library require c TRUE FALSE NULL NA'.split(' '),
    hashComment: true,
    strings: ['\"', '\''],
    funcs: true,
  },
  dart: {
    keywords: 'void var final const class extends implements mixin with new return if else for while do switch case break continue try catch finally throw async await true false null'.split(' '),
    lineComment: '//',
    blockComment: ['/*', '*/'],
    strings: ['\"', '\''],
    funcs: true,
  },
  scala: {
    keywords: 'def val var class object trait extends with match case if else for while do return throw new import package true false null'.split(' '),
    lineComment: '//',
    blockComment: ['/*', '*/'],
    strings: ['\"', '\''],
    funcs: true,
  },
  perl: {
    keywords: 'my sub if elsif else for foreach while until do return use package local our true false undef'.split(' '),
    hashComment: true,
    strings: ['\"', '\''],
    funcs: true,
  },
  objectivec: {
    keywords: 'return if else for while do switch case break continue @interface @implementation @end @property @synthesize @dynamic @selector @protocol import'.split(' '),
    lineComment: '//',
    blockComment: ['/*', '*/'],
    strings: ['\"', '\''],
    funcs: true,
  },
  makefile: {
    keywords: 'define endef ifeq ifneq else endif export include override private vpath'.split(' '),
    hashComment: true,
  },
  dockerfile: {
    keywords: 'from run cmd entrypoint copy add env arg label expose volume workdir user onbuild'.split(' '),
    hashComment: true,
  },
};

// 常见简写别名 → 标准语言
const ALIASES: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  ts: 'typescript',
  py: 'python',
  cs: 'csharp',
  'c#': 'csharp',
  'c++': 'cpp',
  cc: 'cpp',
  h: 'c',
  hpp: 'cpp',
  rb: 'ruby',
  shell: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  yml: 'yaml',
  md: 'markdown',
  'objective-c': 'objectivec',
  plain: 'text',
  text: 'text',
  txt: 'text',
};

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
}

function buildStringPattern(cfg: CodeLangCfg): string {
  const parts: string[] = [];
  for (const q of cfg.strings ?? []) {
    if (q === '\u0060') {
      parts.push('\u0060(?:\\\\.|[^\\\\\u0060])*\u0060');
    } else {
      parts.push(q + '(?:\\\\.|[^\\\\' + escapeRe(q) + '\\n])*' + q);
    }
  }
  return parts.join('|');
}

interface TokenRule {
  re: RegExp;
  cls: string;
}

// 通用扫描：从左到右取“最先出现的匹配”，保证字符串/注释优先于关键字
function runRules(code: string, rules: TokenRule[]): string {
  let out = '';
  let i = 0;
  while (i < code.length) {
    let best: { start: number; end: number; cls: string } | null = null;
    for (const rule of rules) {
      rule.re.lastIndex = i;
      const m = rule.re.exec(code);
      if (m && (best === null || m.index < best.start)) {
        best = { start: m.index, end: m.index + m[0].length, cls: rule.cls };
      }
    }
    if (!best) break;
    if (best.start > i) out += escapeHtml(code.slice(i, best.start));
    out += '<span class=\"' + best.cls + '\">' + escapeHtml(code.slice(best.start, best.end)) + '</span>';
    i = best.end;
  }
  out += escapeHtml(code.slice(i));
  return out;
}

function tokenizeGeneric(code: string, cfg: CodeLangCfg): string {
  const rules: TokenRule[] = [];
  if (cfg.blockComment) {
    rules.push({
      re: new RegExp(escapeRe(cfg.blockComment[0]) + '[\\s\\S]*?' + escapeRe(cfg.blockComment[1]), 'g'),
      cls: 'tok-comment',
    });
  }
  if (cfg.lineComment) {
    rules.push({ re: new RegExp(escapeRe(cfg.lineComment) + '[^\\n]*', 'g'), cls: 'tok-comment' });
  }
  if (cfg.hashComment) {
    rules.push({ re: /#[^\n]*/g, cls: 'tok-comment' });
  }
  const stringPattern = buildStringPattern(cfg);
  if (stringPattern) rules.push({ re: new RegExp(stringPattern, 'g'), cls: 'tok-string' });
  rules.push({ re: /\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, cls: 'tok-number' });
  if (cfg.keywords && cfg.keywords.length) {
    rules.push({
      re: new RegExp('\\b(?:' + cfg.keywords.map(escapeRe).join('|') + ')\\b', 'g'),
      cls: 'tok-keyword',
    });
  }
  if (cfg.funcs) {
    rules.push({ re: /[A-Za-z_$][\w$]*(?=\s*\()/g, cls: 'tok-func' });
  }
  return runRules(code, rules);
}

// HTML/XML 类：标签红色、属性蓝色、字符串绿色
function tokenizeAttrs(attrs: string): string {
  const re = /([A-Za-z_:][\w:.-]*)(\s*=\s*)(?:\"([^\"]*)\"|'([^']*)'|([^\s>]+))/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrs))) {
    out += escapeHtml(attrs.slice(last, m.index));
    out += '<span class=\"tok-attr\">' + escapeHtml(m[1]) + '</span>' + escapeHtml(m[2]);
    const quote = m[3] != null ? '\"' : m[4] != null ? '\'' : '';
    const value = m[3] ?? m[4] ?? m[5];
    out += quote
      ? '<span class=\"tok-string\">' + quote + escapeHtml(value) + quote + '</span>'
      : '<span class=\"tok-string\">' + escapeHtml(value) + '</span>';
    last = m.index + m[0].length;
  }
  out += escapeHtml(attrs.slice(last));
  return out;
}

function tokenizeMarkup(code: string): string {
  const re = /(<!--[\s\S]*?-->)|(<\/?)([A-Za-z][\w:-]*)((?:\s[^<>]*?)?)(\/?>)/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    out += escapeHtml(code.slice(last, m.index));
    if (m[1]) {
      out += '<span class=\"tok-comment\">' + escapeHtml(m[1]) + '</span>';
    } else {
      out += '<span class=\"tok-punct\">' + escapeHtml(m[2]) + '</span>';
      out += '<span class=\"tok-tag\">' + escapeHtml(m[3]) + '</span>';
      out += tokenizeAttrs(m[4]);
      out += '<span class=\"tok-punct\">' + escapeHtml(m[5]) + '</span>';
    }
    last = m.index + m[0].length;
  }
  out += escapeHtml(code.slice(last));
  return out;
}

// CSS/SCSS/Less：注释、字符串、颜色、数字、属性名
function tokenizeCss(code: string): string {
  const rules: TokenRule[] = [
    { re: /\/\*[\s\S]*?\*\//g, cls: 'tok-comment' },
    { re: /\"(?:\\.|[^\"\\\n])*\"|'(?:\\.|[^'\\\n])*'/g, cls: 'tok-string' },
    { re: /#[0-9a-fA-F]{3,8}\b/g, cls: 'tok-number' },
    { re: /@[\w-]+/g, cls: 'tok-keyword' },
    { re: /\b\d[\d.]*(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|fr)?\b/g, cls: 'tok-number' },
    { re: /[A-Za-z-][\w-]*(?=\s*:)/g, cls: 'tok-attr' },
    { re: /\b(?:important|inherit|initial|unset)\b/g, cls: 'tok-keyword' },
  ];
  return runRules(code, rules);
}

// 把高亮 HTML 转成“每行自闭合”：换行处自动闭合未闭合的 span，换行后再重开
// 这样按行切分不会切断标签，隔行变色也才能逐行生效
function makeLineSafe(html: string): string {
  const stack: string[] = [];
  let out = '';
  let inTag = false;
  let tagBuf = '';
  for (let i = 0; i < html.length; i++) {
    const ch = html[i];
    if (!inTag && ch === '<') {
      inTag = true;
      tagBuf = '<';
      continue;
    }
    if (inTag) {
      tagBuf += ch;
      if (ch === '>') {
        inTag = false;
        const tag = tagBuf;
        const closeMatch = /^<\/\s*([a-zA-Z][\w-]*)/.exec(tag);
        if (closeMatch) {
          const name = closeMatch[1];
          for (let j = stack.length - 1; j >= 0; j--) {
            const openName = /^<([a-zA-Z][\w-]*)/.exec(stack[j])?.[1];
            if (openName === name) {
              stack.splice(j, 1);
              break;
            }
          }
        } else {
          const openMatch = /^<([a-zA-Z][\w-]*)(?:\s[^>]*)?>$/.exec(tag);
          if (openMatch && !/\/>$/.test(tag)) stack.push(tag);
        }
        out += tag;
        tagBuf = '';
      }
      continue;
    }
    if (ch === '\n') {
      out += stack.map(() => '</span>').join('');
      out += '\n';
      out += stack.join('');
      continue;
    }
    out += ch;
  }
  out += tagBuf;
  return out;
}

// 把行安全的高亮 HTML 切成行，逐行包 div，奇数行加 alt 实现隔行异色
function buildLineHtml(highlighted: string): string {
  const lines: string[] = [];
  let current = '';
  let inTag = false;
  for (let i = 0; i < highlighted.length; i++) {
    const ch = highlighted[i];
    if (ch === '<') inTag = true;
    else if (ch === '>') inTag = false;
    if (ch === '\n' && !inTag) {
      lines.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  lines.push(current);
  return lines
    .map((line, index) => '<div class="mm-code-line' + (index % 2 === 0 ? ' alt' : '') + '">' + (line || '&#8203;') + '</div>')
    .join('');
}

// 供代码块视图使用：直接返回带隔行底色的行级 HTML
export function highlightCodeLines(code: string, language: string): string {
  return buildLineHtml(makeLineSafe(highlightCode(code, language)));
}

export function highlightCode(code: string, language: string): string {
  const raw = String(language ?? '').toLowerCase();
  const lang = ALIASES[raw] ?? raw;
  if (lang === 'html' || lang === 'xml' || lang === 'svg' || lang === 'vue') {
    return tokenizeMarkup(code);
  }
  if (lang === 'css' || lang === 'scss' || lang === 'less') {
    return tokenizeCss(code);
  }
  const cfg = CONFIGS[lang];
  if (!cfg) return escapeHtml(code);
  return tokenizeGeneric(code, cfg);
}
