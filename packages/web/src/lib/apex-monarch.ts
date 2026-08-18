import type { Monaco } from '@monaco-editor/react';

/**
 * Monaco has no built-in Apex language mode. This registers a Monarch
 * tokenizer good enough for readable diffs — keywords, annotations, types,
 * SOQL/SOSL literals, strings, comments — not a full Apex grammar/parser.
 * Idempotent: safe to call on every editor mount.
 */
export function registerApexLanguage(monaco: Monaco): void {
  const languages = monaco.languages.getLanguages();
  if (languages.some((l: { id: string }) => l.id === 'apex')) return;

  monaco.languages.register({ id: 'apex', extensions: ['.cls', '.trigger'], aliases: ['Apex', 'apex'] });

  const KEYWORDS = [
    'abstract', 'access', 'activate', 'and', 'any', 'array', 'as', 'asc', 'assert', 'autonomous',
    'begin', 'bigdecimal', 'blob', 'boolean', 'break', 'bulk', 'by', 'byte', 'case', 'cast', 'catch',
    'char', 'class', 'collect', 'commit', 'const', 'continue', 'convertcurrency', 'decimal', 'default',
    'delete', 'desc', 'do', 'else', 'end', 'enum', 'exception', 'exit', 'export', 'extends', 'false',
    'final', 'finally', 'float', 'for', 'from', 'future', 'get', 'global', 'goto', 'group', 'having',
    'hint', 'if', 'implements', 'import', 'in', 'inner', 'insert', 'instanceof', 'int', 'interface',
    'into', 'join', 'like', 'limit', 'list', 'long', 'loop', 'map', 'merge', 'new', 'not', 'null',
    'nulls', 'number', 'object', 'of', 'on', 'or', 'outer', 'override', 'package', 'parallel', 'pragma',
    'private', 'protected', 'public', 'retrieve', 'return', 'returning', 'rollback', 'savepoint',
    'search', 'select', 'set', 'short', 'sort', 'stat', 'static', 'string', 'super', 'switch', 'synchronized',
    'system', 'testmethod', 'then', 'this', 'throw', 'transaction', 'transient', 'trigger', 'true', 'try',
    'type', 'undelete', 'update', 'upsert', 'using', 'virtual', 'webservice', 'when', 'where', 'while',
    'with', 'without', 'sharing',
  ];

  const TYPE_KEYWORDS = [
    'void', 'Integer', 'String', 'Boolean', 'Decimal', 'Double', 'Long', 'Date', 'Datetime', 'Time',
    'Id', 'Object', 'List', 'Set', 'Map', 'SObject', 'Schema', 'Database', 'Trigger', 'PageReference',
  ];

  const ANNOTATIONS = [
    'AuraEnabled', 'InvocableMethod', 'InvocableVariable', 'IsTest', 'TestSetup', 'Future', 'RemoteAction',
    'ReadOnly', 'RestResource', 'HttpGet', 'HttpPost', 'HttpPut', 'HttpDelete', 'HttpPatch', 'SuppressWarnings',
    'Deprecated', 'NamespaceAccessible', 'TestVisible',
  ];

  monaco.languages.setMonarchTokensProvider('apex', {
    defaultToken: '',
    tokenPostfix: '.apex',
    keywords: KEYWORDS,
    typeKeywords: TYPE_KEYWORDS,
    annotations: ANNOTATIONS,
    operators: ['=', '>', '<', '!', '~', '?', ':', '==', '<=', '>=', '!=', '&&', '||', '++', '--', '+', '-', '*', '/', '&', '|', '^', '%', '<<', '>>', '+=', '-=', '*=', '/=', '&=', '|=', '^=', '%=', '<<=', '>>='],
    symbols: /[=><!~?:&|+\-*/^%]+/,
    escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4})/,
    tokenizer: {
      root: [
        [/@[a-zA-Z_]\w*/, { cases: { '@annotations': 'annotation', '@default': 'annotation' } }],
        [/[a-zA-Z_]\w*/, { cases: { '@typeKeywords': 'type', '@keywords': 'keyword', '@default': 'identifier' } }],
        { include: '@whitespace' },
        [/[{}()[\]]/, '@brackets'],
        [/[<>](?!@symbols)/, '@brackets'],
        [/@symbols/, { cases: { '@operators': 'operator', '@default': '' } }],
        [/\d+\.\d+([eE][-+]?\d+)?/, 'number.float'],
        [/\d+/, 'number'],
        [/'([^'\\]|\\.)*$/, 'string.invalid'],
        [/'/, { token: 'string.quote', bracket: '@open', next: '@string' }],
      ],
      string: [
        [/[^\\']+/, 'string'],
        [/@escapes/, 'string.escape'],
        [/\\./, 'string.escape.invalid'],
        [/'/, { token: 'string.quote', bracket: '@close', next: '@pop' }],
      ],
      whitespace: [
        [/[ \t\r\n]+/, ''],
        [/\/\*/, 'comment', '@comment'],
        [/\/\/.*$/, 'comment'],
      ],
      comment: [
        [/[^/*]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[/*]/, 'comment'],
      ],
    },
  });

  monaco.languages.setLanguageConfiguration('apex', {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: "'", close: "'" },
    ],
  });
}
