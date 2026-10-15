// Parsing front-ends that produce one ESTree-shaped tree for the rule engine:
// Acorn for standard JavaScript, and a lossless-enough TypeScript AST adapter for TS/TSX/JSX.
import * as acorn from '../acorn.mjs';

const SKIP_KEYS = new Set(['loc', 'start', 'end', 'range', 'raw', 'parenthesized', 'typeAnnotation', 'typeText', 'leadingComments']);

export function isNode(value) { return value && typeof value === 'object' && typeof value.type === 'string'; }

export function childNodes(node) {
  const out = [];
  for (const key in node) {
    if (SKIP_KEYS.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) { for (const v of value) if (isNode(v)) out.push(v); }
    else if (isNode(value)) out.push(value);
  }
  return out;
}

// Depth-first traversal with an ancestor stack. visit(node, ancestors) may return false to skip children;
// leave(node) runs after a node's children have been visited.
export function walk(root, visit, leave) {
  const ancestors = [];
  const step = node => {
    if (visit(node, ancestors) === false) return;
    ancestors.push(node);
    for (const child of childNodes(node)) step(child);
    ancestors.pop();
    leave?.(node);
  };
  step(root);
}

// Replaces ParenthesizedExpression wrappers with their contents, flagging `parenthesized`.
function stripParens(root) {
  walk(root, node => {
    for (const key in node) {
      if (SKIP_KEYS.has(key)) continue;
      const value = node[key];
      const unwrap = v => { let inner = v; while (inner?.type === 'ParenthesizedExpression') inner = inner.expression; if (inner !== v) inner.parenthesized = true; return inner; };
      if (Array.isArray(value)) node[key] = value.map(v => (isNode(v) ? unwrap(v) : v));
      else if (isNode(value)) node[key] = unwrap(value);
    }
  });
  return root;
}

// Parses JavaScript as an ES module first, then as a CommonJS script. Returns the better diagnosis on failure.
export function parseJavaScript(code) {
  const comments = [];
  const base = { ecmaVersion: 'latest', allowHashBang: true, locations: true, preserveParens: true, onComment: comments };
  try {
    return { ast: stripParens(acorn.parse(code, { ...base, sourceType: 'module' })), sourceType: 'module', comments };
  } catch (moduleError) {
    comments.length = 0;
    try {
      return { ast: stripParens(acorn.parse(code, { ...base, sourceType: 'script', allowReturnOutsideFunction: true })), sourceType: 'script', comments };
    } catch (scriptError) {
      const looksModule = /^\s*(?:import\s|export\s)/m.test(code);
      const e = looksModule ? moduleError : scriptError;
      return { ast: null, comments: [], error: { message: e.message.replace(/\s*\(\d+:\d+\)$/, ''), line: e.loc?.line || 1, column: (e.loc?.column ?? 0) + 1, pos: e.pos ?? 0 } };
    }
  }
}

export const looksLikeJsx = code => /<\/[A-Za-z][\w.]*\s*>|<[A-Z][\w.]*[\s/>]|<>\s*|\/>\s*[)\n]/.test(code);

// ---------------------------------------------------------------------------------------------
// TypeScript AST -> ESTree-lite adapter. Only the shapes used by the rules are produced; unknown
// nodes become generic containers so traversal still reaches nested code.
export function parseWithTypeScript(ts, path, code, { jsx = false, js = false } = {}) {
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : path.endsWith('.jsx') || (js && jsx) ? ts.ScriptKind.JSX : js ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true, kind);
  const diagnostics = (sf.parseDiagnostics || []).map(d => {
    const p = sf.getLineAndCharacterOfPosition(d.start || 0);
    return { code: d.code, message: ts.flattenDiagnosticMessageText(d.messageText, ' '), line: p.line + 1, column: p.character + 1, pos: d.start || 0 };
  });
  const anyKeywords = [];
  const ast = convertTs(ts, sf, anyKeywords);
  return { ast, sourceFile: sf, diagnostics, anyKeywords };
}

function convertTs(ts, sf, anyKeywords) {
  const K = ts.SyntaxKind;
  const loc = node => {
    const start = node.getStart(sf);
    const s = sf.getLineAndCharacterOfPosition(start), e = sf.getLineAndCharacterOfPosition(node.end);
    return { start, end: node.end, loc: { start: { line: s.line + 1, column: s.character }, end: { line: e.line + 1, column: e.character } } };
  };
  const hasMod = (node, kind) => (ts.getModifiers?.(node) || node.modifiers || []).some(m => m.kind === kind);
  const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=']);
  const scanTypes = node => {
    const visit = n => { if (n.kind === K.AnyKeyword) anyKeywords.push(loc(n)); ts.forEachChild(n, visit); };
    if (node) visit(node);
  };
  const typeText = node => { if (!node) return undefined; scanTypes(node); return node.getText(sf); };
  const list = nodes => (nodes ? Array.from(nodes, c).filter(Boolean) : []);
  const fn = (node, type) => ({
    type, id: node.name && node.name.kind === K.Identifier ? c(node.name) : null,
    params: list(node.parameters), body: node.body ? c(node.body) : null,
    async: hasMod(node, K.AsyncKeyword), generator: Boolean(node.asteriskToken), expression: node.body && node.body.kind !== K.Block,
    returnType: typeText(node.type), ...loc(node),
  });
  const propKey = name => (name.kind === K.ComputedPropertyName ? c(name.expression) : c(name));

  function c(node) {
    if (!node) return null;
    const L = () => loc(node);
    switch (node.kind) {
      case K.SourceFile: return { type: 'Program', body: list(node.statements), sourceType: 'module', ...L() };
      case K.Block: case K.ModuleBlock: return { type: 'BlockStatement', body: list(node.statements), ...L() };
      case K.VariableStatement: return { ...c(node.declarationList), ...L(), exported: hasMod(node, K.ExportKeyword) };
      case K.VariableDeclarationList: {
        const flags = node.flags;
        return { type: 'VariableDeclaration', kind: flags & ts.NodeFlags.Const ? 'const' : flags & ts.NodeFlags.Let ? 'let' : (flags & (ts.NodeFlags.Using || 0)) ? 'using' : 'var', declarations: list(node.declarations), ...L() };
      }
      case K.VariableDeclaration: return { type: 'VariableDeclarator', id: c(node.name), init: c(node.initializer), typeText: typeText(node.type), ...L() };
      case K.ExpressionStatement: return { type: 'ExpressionStatement', expression: c(node.expression), ...L() };
      case K.IfStatement: return { type: 'IfStatement', test: c(node.expression), consequent: c(node.thenStatement), alternate: c(node.elseStatement), ...L() };
      case K.ReturnStatement: return { type: 'ReturnStatement', argument: c(node.expression), ...L() };
      case K.ThrowStatement: return { type: 'ThrowStatement', argument: c(node.expression), ...L() };
      case K.BreakStatement: return { type: 'BreakStatement', label: c(node.label), ...L() };
      case K.ContinueStatement: return { type: 'ContinueStatement', label: c(node.label), ...L() };
      case K.SwitchStatement: return { type: 'SwitchStatement', discriminant: c(node.expression), cases: list(node.caseBlock.clauses), ...L() };
      case K.CaseClause: return { type: 'SwitchCase', test: c(node.expression), consequent: list(node.statements), ...L() };
      case K.DefaultClause: return { type: 'SwitchCase', test: null, consequent: list(node.statements), ...L() };
      case K.TryStatement: return { type: 'TryStatement', block: c(node.tryBlock), handler: node.catchClause ? { type: 'CatchClause', param: node.catchClause.variableDeclaration ? c(node.catchClause.variableDeclaration.name) : null, body: c(node.catchClause.block), ...loc(node.catchClause) } : null, finalizer: c(node.finallyBlock), ...L() };
      case K.ForStatement: return { type: 'ForStatement', init: c(node.initializer), test: c(node.condition), update: c(node.incrementor), body: c(node.statement), ...L() };
      case K.ForInStatement: return { type: 'ForInStatement', left: c(node.initializer), right: c(node.expression), body: c(node.statement), ...L() };
      case K.ForOfStatement: return { type: 'ForOfStatement', left: c(node.initializer), right: c(node.expression), body: c(node.statement), await: Boolean(node.awaitModifier), ...L() };
      case K.WhileStatement: return { type: 'WhileStatement', test: c(node.expression), body: c(node.statement), ...L() };
      case K.DoStatement: return { type: 'DoWhileStatement', body: c(node.statement), test: c(node.expression), ...L() };
      case K.LabeledStatement: return { type: 'LabeledStatement', label: c(node.label), body: c(node.statement), ...L() };
      case K.EmptyStatement: return { type: 'EmptyStatement', ...L() };
      case K.DebuggerStatement: return { type: 'DebuggerStatement', ...L() };
      case K.FunctionDeclaration: return { ...fn(node, 'FunctionDeclaration'), exported: hasMod(node, K.ExportKeyword), isDefault: hasMod(node, K.DefaultKeyword) };
      case K.FunctionExpression: return fn(node, 'FunctionExpression');
      case K.ArrowFunction: return fn(node, 'ArrowFunctionExpression');
      case K.Parameter: {
        scanTypes(node.type);
        let p = c(node.name);
        if (node.dotDotDotToken) p = { type: 'RestElement', argument: p, ...L() };
        else if (node.initializer) p = { type: 'AssignmentPattern', left: p, right: c(node.initializer), ...L() };
        p.typeText = node.type ? node.type.getText(sf) : undefined;
        p.optional = Boolean(node.questionToken);
        return p;
      }
      case K.ClassDeclaration: case K.ClassExpression:
        return { type: node.kind === K.ClassDeclaration ? 'ClassDeclaration' : 'ClassExpression', id: c(node.name), superClass: c(node.heritageClauses?.find(h => h.token === K.ExtendsKeyword)?.types?.[0]?.expression), body: { type: 'ClassBody', body: list(node.members), ...L() }, exported: hasMod(node, K.ExportKeyword), ...L() };
      case K.MethodDeclaration: case K.Constructor: case K.GetAccessor: case K.SetAccessor: {
        const kind = node.kind === K.Constructor ? 'constructor' : node.kind === K.GetAccessor ? 'get' : node.kind === K.SetAccessor ? 'set' : 'method';
        const value = fn(node, 'FunctionExpression');
        if (node.parent && node.parent.kind === K.ObjectLiteralExpression) return { type: 'Property', key: propKey(node.name), value, kind: kind === 'method' ? 'init' : kind, method: kind === 'method', computed: node.name.kind === K.ComputedPropertyName, ...L() };
        return { type: 'MethodDefinition', key: node.name ? propKey(node.name) : { type: 'Identifier', name: 'constructor', ...L() }, value, kind, static: hasMod(node, K.StaticKeyword), ...L() };
      }
      case K.PropertyDeclaration: return { type: 'PropertyDefinition', key: propKey(node.name), value: c(node.initializer), typeText: typeText(node.type), ...L() };
      case K.CallExpression:
        if (node.expression.kind === K.ImportKeyword) return { type: 'ImportExpression', source: c(node.arguments[0]), ...L() };
        return { type: 'CallExpression', callee: c(node.expression), arguments: list(node.arguments), optional: Boolean(node.questionDotToken), ...L() };
      case K.NewExpression: return { type: 'NewExpression', callee: c(node.expression), arguments: list(node.arguments), ...L() };
      case K.PropertyAccessExpression: return { type: 'MemberExpression', object: c(node.expression), property: c(node.name), computed: false, optional: Boolean(node.questionDotToken), ...L() };
      case K.ElementAccessExpression: return { type: 'MemberExpression', object: c(node.expression), property: c(node.argumentExpression), computed: true, optional: Boolean(node.questionDotToken), ...L() };
      case K.Identifier: return { type: 'Identifier', name: node.text, ...L() };
      case K.PrivateIdentifier: return { type: 'PrivateIdentifier', name: node.text.slice(1), ...L() };
      case K.StringLiteral: return { type: 'Literal', value: node.text, raw: node.getText(sf), ...L() };
      case K.NoSubstitutionTemplateLiteral: return { type: 'TemplateLiteral', quasis: [{ type: 'TemplateElement', value: { cooked: node.text, raw: node.text }, ...L() }], expressions: [], ...L() };
      case K.NumericLiteral: return { type: 'Literal', value: Number(node.text), raw: node.getText(sf), ...L() };
      case K.BigIntLiteral: return { type: 'Literal', value: null, bigint: node.text, raw: node.text, ...L() };
      case K.RegularExpressionLiteral: return { type: 'Literal', value: null, regex: { pattern: node.text }, raw: node.text, ...L() };
      case K.TrueKeyword: return { type: 'Literal', value: true, raw: 'true', ...L() };
      case K.FalseKeyword: return { type: 'Literal', value: false, raw: 'false', ...L() };
      case K.NullKeyword: return { type: 'Literal', value: null, raw: 'null', ...L() };
      case K.ThisKeyword: return { type: 'ThisExpression', ...L() };
      case K.SuperKeyword: return { type: 'Super', ...L() };
      case K.TemplateExpression:
        return { type: 'TemplateLiteral', quasis: [node.head, ...node.templateSpans.map(s => s.literal)].map(q => ({ type: 'TemplateElement', value: { cooked: q.text, raw: q.text }, ...loc(q) })), expressions: node.templateSpans.map(s => c(s.expression)), ...L() };
      case K.TaggedTemplateExpression: return { type: 'TaggedTemplateExpression', tag: c(node.tag), quasi: c(node.template), ...L() };
      case K.BinaryExpression: {
        const op = ts.tokenToString(node.operatorToken.kind);
        if (op === ',') return { type: 'SequenceExpression', expressions: [c(node.left), c(node.right)], ...L() };
        if (ASSIGN.has(op)) return { type: 'AssignmentExpression', operator: op, left: c(node.left), right: c(node.right), ...L() };
        if (op === '&&' || op === '||' || op === '??') return { type: 'LogicalExpression', operator: op, left: c(node.left), right: c(node.right), ...L() };
        return { type: 'BinaryExpression', operator: op, left: c(node.left), right: c(node.right), ...L() };
      }
      case K.PrefixUnaryExpression: {
        const op = ts.tokenToString(node.operator);
        if (op === '++' || op === '--') return { type: 'UpdateExpression', operator: op, prefix: true, argument: c(node.operand), ...L() };
        return { type: 'UnaryExpression', operator: op, prefix: true, argument: c(node.operand), ...L() };
      }
      case K.PostfixUnaryExpression: return { type: 'UpdateExpression', operator: ts.tokenToString(node.operator), prefix: false, argument: c(node.operand), ...L() };
      case K.TypeOfExpression: return { type: 'UnaryExpression', operator: 'typeof', argument: c(node.expression), ...L() };
      case K.VoidExpression: return { type: 'UnaryExpression', operator: 'void', argument: c(node.expression), ...L() };
      case K.DeleteExpression: return { type: 'UnaryExpression', operator: 'delete', argument: c(node.expression), ...L() };
      case K.AwaitExpression: return { type: 'AwaitExpression', argument: c(node.expression), ...L() };
      case K.YieldExpression: return { type: 'YieldExpression', argument: c(node.expression), ...L() };
      case K.ConditionalExpression: return { type: 'ConditionalExpression', test: c(node.condition), consequent: c(node.whenTrue), alternate: c(node.whenFalse), ...L() };
      case K.ParenthesizedExpression: { const inner = c(node.expression); if (inner) inner.parenthesized = true; return inner; }
      case K.AsExpression: case K.TypeAssertionExpression: case K.SatisfiesExpression: scanTypes(node.type); return c(node.expression);
      case K.NonNullExpression: case K.ExpressionWithTypeArguments: return c(node.expression);
      case K.ArrayLiteralExpression: return { type: 'ArrayExpression', elements: list(node.elements), ...L() };
      case K.SpreadElement: case K.SpreadAssignment: return { type: 'SpreadElement', argument: c(node.expression), ...L() };
      case K.ObjectLiteralExpression: return { type: 'ObjectExpression', properties: list(node.properties), ...L() };
      case K.PropertyAssignment: return { type: 'Property', key: propKey(node.name), value: c(node.initializer), kind: 'init', computed: node.name.kind === K.ComputedPropertyName, ...L() };
      case K.ShorthandPropertyAssignment: { const key = c(node.name); return { type: 'Property', key, value: key, kind: 'init', shorthand: true, computed: false, ...L() }; }
      case K.ArrayBindingPattern: return { type: 'ArrayPattern', elements: list(node.elements), ...L() };
      case K.ObjectBindingPattern: return { type: 'ObjectPattern', properties: list(node.elements), ...L() };
      case K.BindingElement: return { type: 'Property', key: node.propertyName ? c(node.propertyName) : c(node.name), value: node.initializer ? { type: 'AssignmentPattern', left: c(node.name), right: c(node.initializer), ...L() } : c(node.name), kind: 'init', ...L() };
      case K.OmittedExpression: return null;
      case K.ImportDeclaration: {
        const clause = node.importClause;
        const specifiers = [];
        if (clause?.name) specifiers.push({ type: 'ImportDefaultSpecifier', local: c(clause.name), ...loc(clause.name) });
        const nb = clause?.namedBindings;
        if (nb?.kind === K.NamespaceImport) specifiers.push({ type: 'ImportNamespaceSpecifier', local: c(nb.name), ...loc(nb) });
        if (nb?.kind === K.NamedImports) for (const el of nb.elements) specifiers.push({ type: 'ImportSpecifier', imported: c(el.propertyName || el.name), local: c(el.name), importKind: el.isTypeOnly ? 'type' : 'value', ...loc(el) });
        return { type: 'ImportDeclaration', source: c(node.moduleSpecifier), specifiers, importKind: clause?.isTypeOnly ? 'type' : 'value', ...L() };
      }
      case K.ImportEqualsDeclaration: {
        const ref = node.moduleReference;
        if (ref.kind === K.ExternalModuleReference) return { type: 'VariableDeclaration', kind: 'const', declarations: [{ type: 'VariableDeclarator', id: c(node.name), init: { type: 'CallExpression', callee: { type: 'Identifier', name: 'require', ...L() }, arguments: [c(ref.expression)], ...L() }, ...L() }], ...L() };
        return null;
      }
      case K.ExportDeclaration: {
        if (!node.exportClause && node.moduleSpecifier) return { type: 'ExportAllDeclaration', source: c(node.moduleSpecifier), exportKind: node.isTypeOnly ? 'type' : 'value', ...L() };
        const specifiers = node.exportClause?.kind === K.NamedExports ? node.exportClause.elements.map(el => ({ type: 'ExportSpecifier', local: c(el.propertyName || el.name), exported: c(el.name), exportKind: el.isTypeOnly ? 'type' : 'value', ...loc(el) })) : [];
        if (node.exportClause?.kind === K.NamespaceExport) return { type: 'ExportAllDeclaration', source: c(node.moduleSpecifier), exported: c(node.exportClause.name), ...L() };
        return { type: 'ExportNamedDeclaration', declaration: null, specifiers, source: c(node.moduleSpecifier), exportKind: node.isTypeOnly ? 'type' : 'value', ...L() };
      }
      case K.ExportAssignment: return { type: 'ExportDefaultDeclaration', declaration: c(node.expression), exportEquals: Boolean(node.isExportEquals), ...L() };
      case K.InterfaceDeclaration: case K.TypeAliasDeclaration: scanTypes(node); return { type: 'TSTypeDeclaration', id: c(node.name), exported: hasMod(node, K.ExportKeyword), ...L() };
      case K.EnumDeclaration: return { type: 'TSEnumDeclaration', id: c(node.name), exported: hasMod(node, K.ExportKeyword), ...L() };
      case K.ModuleDeclaration: return { type: 'TSModuleDeclaration', id: c(node.name), body: c(node.body), ...L() };
      case K.JsxElement: return { type: 'JSXElement', openingElement: c(node.openingElement), children: list(node.children), ...L() };
      case K.JsxSelfClosingElement: case K.JsxOpeningElement: return { type: 'JSXOpeningElement', name: { type: 'JSXIdentifier', name: node.tagName.getText(sf), ...loc(node.tagName) }, attributes: list(node.attributes.properties), ...L() };
      case K.JsxFragment: return { type: 'JSXFragment', children: list(node.children), ...L() };
      case K.JsxAttribute: return { type: 'JSXAttribute', name: { type: 'JSXIdentifier', name: node.name.getText(sf), ...loc(node.name) }, value: c(node.initializer), ...L() };
      case K.JsxSpreadAttribute: return { type: 'JSXSpreadAttribute', argument: c(node.expression), ...L() };
      case K.JsxExpression: return { type: 'JSXExpressionContainer', expression: c(node.expression), ...L() };
      case K.JsxText: return null;
      case K.Decorator: return { type: 'Decorator', expression: c(node.expression), ...L() };
      default: {
        if (node.kind >= K.FirstTypeNode && node.kind <= K.LastTypeNode) { scanTypes(node); return null; }
        const children = [];
        ts.forEachChild(node, child => { const converted = c(child); if (converted) children.push(converted); });
        return { type: 'TS' + (K[node.kind] || 'Node'), children, ...L() };
      }
    }
  }
  return c(sf);
}
