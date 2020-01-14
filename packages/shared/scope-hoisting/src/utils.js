// @flow
import type {Asset, MutableAsset, Bundle, BundleGraph} from '@parcel/types';
import * as t from '@babel/types';
import {simple as walkSimple} from 'babylon-walk';

export function getName(
  asset: Asset | MutableAsset,
  type: string,
  ...rest: Array<string>
) {
  return (
    '$' +
    t.toIdentifier(asset.id) +
    '$' +
    type +
    (rest.length
      ? '$' +
        rest
          .map(name => (name === 'default' ? name : t.toIdentifier(name)))
          .join('$')
      : '')
  );
}

export function getIdentifier(
  asset: Asset | MutableAsset,
  type: string,
  ...rest: Array<string>
) {
  return t.identifier(getName(asset, type, ...rest));
}

export function getExportIdentifier(asset: Asset | MutableAsset, name: string) {
  return getIdentifier(asset, 'export', name);
}

export function needsPrelude(bundle: Bundle, bundleGraph: BundleGraph) {
  if (bundle.env.outputFormat !== 'global') {
    return false;
  }

  // If this is an entry bundle and it is referenced by other bundles,
  // we need to add the prelude code, which allows registering modules dynamically at runtime.
  return isEntry(bundle, bundleGraph) && isReferenced(bundle, bundleGraph);
}

export function isEntry(bundle: Bundle, bundleGraph: BundleGraph) {
  // If there is no parent JS bundle (e.g. in an HTML page), or environment is isolated (e.g. worker)
  // then this bundle is an "entry"
  return (
    !bundleGraph.hasParentBundleOfType(bundle, 'js') || bundle.env.isIsolated()
  );
}

export function isReferenced(bundle: Bundle, bundleGraph: BundleGraph) {
  // A bundle is potentially referenced if there are any child or sibling JS bundles that are not isolated
  return [
    ...bundleGraph.getChildBundles(bundle),
    ...bundleGraph.getSiblingBundles(bundle),
  ].some(
    b => b.type === 'js' && (!b.env.isIsolated() || bundle.env.isIsolated()),
  );
}

const RemoveVisitor = {
  Identifier(node, scope) {
    dereferenceIdentifier(node, scope);
  },
};

// like path.remove(), but updates bindings in path.scope.getProgramParent()
export function pathRemove(path: any) {
  let scope = path.scope.getProgramParent();
  walkSimple(path.node, RemoveVisitor, scope);
  path.remove();
}

// like path.replaceWith(node), but updates bindings in path.scope.getProgramParent()
export function pathReplaceWith(path: any, node: any) {
  let scope = path.scope.getProgramParent();
  walkSimple(path.node, RemoveVisitor, scope);
  let path2 = path.replaceWith(node);
  // TODO what?
  path2 = Array.isArray(path2) ? path2[0] : path2;
  if (path2.isDeclaration()) {
    scope.registerDeclaration(path2);
  }
  crawlGlobal(path2, scope);
  return path2;
}

// like path.insertBefore(node), but updates bindings in path.scope.getProgramParent()
export function pathInsertBefore(path: any, node: any) {
  let scope = path.scope.getProgramParent();
  let [path2] = path.insertBefore(node);
  if (path2.isDeclaration()) {
    scope.registerDeclaration(path2);
  }
  crawlGlobal(path2, scope);
  return path2;
}

// like path.insertAfter(node), but updates bindings in path.scope.getProgramParent()
export function pathInsertAfter(path: any, node: any) {
  let scope = path.scope.getProgramParent();
  let [path2] = path.insertAfter(node);
  if (path2.isDeclaration()) {
    scope.registerDeclaration(path2);
  }
  crawlGlobal(path2, scope);
  return path2;
}

// like path.unshiftContainer(nodes), but updates bindings in path.scope.getProgramParent()
export function pathUnshiftContainer(
  path: any,
  listKey: string,
  nodes: Array<any>,
) {
  let scope = path.scope.getProgramParent();
  let paths = path.unshiftContainer(listKey, nodes);
  for (let p of paths) {
    if (p.isDeclaration()) {
      scope.registerDeclaration(p);
    }
    crawlGlobal(p, scope);
  }
}

// like path.pushContainer(nodes), but updates bindings in path.scope.getProgramParent()
export function pathPushContainer(
  path: any,
  listKey: string,
  nodes: Array<any>,
) {
  let scope = path.scope.getProgramParent();
  let paths = path.pushContainer(listKey, nodes);
  for (let p of paths) {
    if (p.isDeclaration()) {
      scope.registerDeclaration(p);
    }
    crawlGlobal(p, scope);
  }
}

function dereferenceIdentifier(node, scope) {
  let binding = scope.getBinding(node.name);
  if (binding) {
    let i = binding.referencePaths.findIndex(v => v.node === node);
    if (i >= 0) {
      binding.dereference();
      binding.referencePaths.splice(i, 1);
      return;
    }

    let j = binding.constantViolations.findIndex(v =>
      Object.values(v.getBindingIdentifiers()).includes(node),
    );
    if (j >= 0) {
      binding.constantViolations.splice(j, 1);
      if (binding.constantViolations.length == 0) {
        binding.constant = true;
      }
      return;
    }
  }
}

function crawlGlobal(path, scope) {
  if (!path) return;

  const keys = t.VISITOR_KEYS[path.type];
  if (!keys) return;

  switch (path.type) {
    case 'Identifier':
      {
        let binding = scope.getBinding(path.node.name);
        if (binding) binding.reference(path);
      }
      break;
    case 'AssignmentExpression':
    case 'UpdateExpression':
      scope.registerConstantViolation(path);
      break;
  }

  for (const key of keys) {
    const subNode = path.get(key);

    if (Array.isArray(subNode)) {
      for (const path of subNode) {
        crawlGlobal(path, scope);
      }
    } else {
      crawlGlobal(subNode, scope);
    }
  }
}
