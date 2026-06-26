// Serialize a PZ-script AST back to text.
import type { AnyNode, RootNode } from './types.js';

function indent(depth: number): string {
  return '    '.repeat(depth);
}

export function serializeNode(node: AnyNode, depth: number): string {
  switch (node.type) {
    case 'root':
      return node.children.map((c) => serializeNode(c, depth)).join('\n');

    case 'block': {
      const pad = indent(depth);
      const header = node.name ? `${node.keyword} ${node.name}` : node.keyword;
      const inner = node.children.length === 0
        ? `${pad}${header}\n${pad}{\n${pad}}`
        : `${pad}${header}\n${pad}{\n${node.children.map((c) => serializeNode(c, depth + 1)).join('\n')}\n${pad}}`;
      if (node.commentedOut !== undefined) {
        return `${pad}/* [B41->B42] ${node.commentedOut}\n${inner}\n${pad}*/`;
      }
      return inner;
    }

    case 'prop': {
      const pad = indent(depth);
      const spaced = node.op === '=' ? ' = ' : ':';
      return `${pad}${node.key}${spaced}${node.value},`;
    }

    case 'line': {
      const pad = indent(depth);
      return node.noComma === true ? `${pad}${node.text}` : `${pad}${node.text},`;
    }

    case 'raw':
      return node.text
        .split('\n')
        .map((l) => (l ? indent(depth) + l : l))
        .join('\n');

    default: {
      // Exhaustiveness guard.
      const _never: never = node;
      return _never;
    }
  }
}

export function serializeScript(root: RootNode): string {
  return serializeNode(root, 0) + '\n';
}
