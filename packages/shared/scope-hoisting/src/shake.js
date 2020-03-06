// @flow
import type {Symbol} from '@parcel/types';
import type {NodePath, Scope} from '@babel/traverse';
import type {Node} from '@babel/types';

import {
  isAssignmentExpression,
  isCallExpression,
  isExpressionStatement,
  isIdentifier,
  isMemberExpression,
  isSequenceExpression,
  isVariableDeclarator,
} from '@babel/types';
import invariant from 'assert';
import {pathRemove} from './utils';

/**
 * This is a small small implementation of dead code removal specialized to handle
 * removing unused exports. All other dead code removal happens in workers on each
 * individual file by babel-minify.
 */
export default function treeShake(
  scope: Scope,
  exportedIdentifiers: Set<Symbol>,
) {
  // Keep passing over all bindings in the scope until we don't remove any.
  // This handles cases where we remove one binding which had a reference to
  // another one. That one will get removed in the next pass if it is now unreferenced.
  let removed;
  do {
    removed = false;

    Object.keys(scope.bindings).forEach((name: string) => {
      let binding = getUnusedBinding(scope.path, name);

      // If it is not safe to remove the binding don't touch it.
      if (!binding || exportedIdentifiers.has(name)) {
        return;
      }

      // Remove the binding and all references to it.
      pathRemove(binding.path);
      [...binding.referencePaths, ...binding.constantViolations].forEach(
        remove,
      );

      scope.removeBinding(name);
      removed = true;
    });
  } while (removed);
}

// Check if a binding is safe to remove and returns it if it is.
function getUnusedBinding(path, name) {
  let binding = path.scope.getBinding(name);
  if (!binding) {
    return null;
  }

  let pure = isPure(binding);
  if (!binding.referenced && pure) {
    return binding;
  }

  // Is there any references which aren't simple assignments?
  let bailout = binding.referencePaths.some(
    path => !isExportAssignment(path) && !isUnusedWildcard(path),
  );

  if (!bailout && pure) {
    return binding;
  }

  return null;
}

function isPure(binding) {
  if (
    binding.path.isVariableDeclarator() &&
    binding.path.get('id').isIdentifier()
  ) {
    let init = binding.path.get('init');
    return (
      init.isPure() ||
      init.isIdentifier() ||
      init.isThisExpression() ||
      (isVariableDeclarator(binding.path.node) &&
        isIdentifier(binding.path.node.id, {name: '$parcel$global'}))
    );
  }

  return binding.path.isPure();
}

function isExportAssignment(path) {
  let {parent} = path;
  // match "path.foo = bar;"
  if (isMemberExpression(parent) && parent.object === path.node) {
    let parentParent = path.parentPath.parent;
    return isAssignmentExpression(parentParent) && parentParent.left === parent;
  }
  return false;
}

function isUnusedWildcard(path) {
  let parent: Node = path.parent;

  if (
    // match `$parcel$exportWildcard` calls
    isCallExpression(parent) &&
    isIdentifier(parent.callee, {name: '$parcel$exportWildcard'}) &&
    parent.arguments[0] === path.node
  ) {
    // check if the $id$exports variable is used}
    let [, id] = parent.arguments;
    invariant(isIdentifier(id));
    return !getUnusedBinding(path, id.name);
  }

  return false;
}

function remove(path: NodePath<Node>) {
  let {node, parent} = path;
  if (isAssignmentExpression(node)) {
    let right;
    if (isSequenceExpression(parent) && parent.expressions.length === 1) {
      // replace sequence expression with it's sole child
      path.parentPath.replaceWith(node);
      remove(path.parentPath);
    } else if (
      //e.g. `exports.foo = bar;`, `bar` needs to be pure (an Identifier isn't ?!)
      isExpressionStatement(parent) &&
      ((right = path.get('right')).isPure() || right.isIdentifier())
    ) {
      pathRemove(path);
    } else {
      // right side isn't pure
      path.replaceWith(node.right);
    }
  } else if (isExportAssignment(path)) {
    remove(path.parentPath.parentPath);
  } else if (isUnusedWildcard(path)) {
    remove(path.parentPath);
  } else if (!path.removed) {
    if (isSequenceExpression(parent) && parent.expressions.length === 1) {
      // replace sequence expression with it's sole child
      path.parentPath.replaceWith(node);
      remove(path.parentPath);
    } else {
      pathRemove(path);
    }
  }
}
