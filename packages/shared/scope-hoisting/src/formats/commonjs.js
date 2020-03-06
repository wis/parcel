// @flow

import type {
  Asset,
  Bundle,
  BundleGraph,
  PluginOptions,
  Symbol,
} from '@parcel/types';
import type {
  Expression,
  ExpressionStatement,
  Identifier,
  LVal,
  ObjectProperty,
  Program,
  VariableDeclarator,
  VariableDeclaration,
} from '@babel/types';
import type {NodePath, Scope} from '@babel/traverse';
import type {ExternalModule} from '../types';

import * as t from '@babel/types';
import {isIdentifier} from '@babel/types';
import template from '@babel/template';
import invariant from 'assert';
import nullthrows from 'nullthrows';
import {relative} from 'path';
import {relativeBundlePath} from '@parcel/utils';
import ThrowableDiagnostic from '@parcel/diagnostic';
import rename from '../renamer';
import {assertString, removeReplaceBinding} from '../utils';

const REQUIRE_TEMPLATE: ({|
  BUNDLE: Expression,
  // $FlowFixMe
|}) => Expression = template.expression('require(BUNDLE)');
const EXPORT_TEMPLATE: ({|
  NAME: Identifier,
  IDENTIFIER: Expression,
  // $FlowFixMe
|}) => ExpressionStatement = template.statement('exports.NAME = IDENTIFIER;');
const MODULE_EXPORTS_TEMPLATE: ({|
  IDENTIFIER: Expression,
  // $FlowFixMe
|}) => ExpressionStatement = template.statement('module.exports = IDENTIFIER;');
const INTEROP_TEMPLATE: ({|
  MODULE: Expression,
  // $FlowFixMe
|}) => Expression = template.expression('$parcel$interopDefault(MODULE)');
const ASSIGN_TEMPLATE: ({|
  SPECIFIERS: LVal,
  MODULE: Expression,
  // $FlowFixMe
|}) => VariableDeclaration = template.statement('var SPECIFIERS = MODULE;');
const NAMESPACE_TEMPLATE: ({|
  NAMESPACE: Expression,
  MODULE: Expression,
  // $FlowFixMe
|}) => Expression = template.expression(
  '$parcel$exportWildcard(NAMESPACE, MODULE)',
);

// List of engines that support object destructuring syntax
const DESTRUCTURING_ENGINES = {
  chrome: '51',
  edge: '15',
  firefox: '53',
  safari: '10',
  node: '6.5',
  ios: '10',
  samsung: '5',
  opera: '38',
  electron: '1.2',
};

function generateDestructuringAssignment(
  env,
  specifiers,
  value: Expression,
  scope: Scope,
): Array<VariableDeclaration> {
  // If destructuring is not supported, generate a series of variable declarations
  // with member expressions for each property.
  if (!env.matchesEngines(DESTRUCTURING_ENGINES)) {
    let statements = [];
    if (!t.isIdentifier(value) && specifiers.length > 1) {
      let name = scope.generateUid();
      statements.push(
        ASSIGN_TEMPLATE({
          SPECIFIERS: t.identifier(name),
          MODULE: value,
        }),
      );
      value = t.identifier(name);
    }

    for (let specifier of specifiers) {
      invariant(isIdentifier(specifier.value));
      statements.push(
        ASSIGN_TEMPLATE({
          SPECIFIERS: specifier.value,
          MODULE: t.memberExpression(value, specifier.key),
        }),
      );
    }

    return statements;
  }

  return [
    ASSIGN_TEMPLATE({
      SPECIFIERS: t.objectPattern(specifiers),
      MODULE: value,
    }),
  ];
}

export function generateBundleImports(
  from: Bundle,
  bundle: Bundle,
  assets: Set<Asset>,
  path: NodePath<Program>,
) {
  let specifiers: Array<ObjectProperty> = [...assets].map(asset => {
    let id = t.identifier(assertString(asset.meta.exportsIdentifier));
    return t.objectProperty(id, id, false, true);
  });

  let expression = REQUIRE_TEMPLATE({
    BUNDLE: t.stringLiteral(relativeBundlePath(from, bundle)),
  });

  if (specifiers.length > 0) {
    let decls = path.unshiftContainer(
      'body',
      generateDestructuringAssignment(
        bundle.env,
        specifiers,
        expression,
        path.scope,
      ),
    );
    for (let decl of decls) {
      // every VariableDeclaration emitted by generateDestructuringAssignment has only
      // one VariableDeclarator
      let next = decl.get<NodePath<VariableDeclarator>>('declarations.0');
      for (let [name] of (Object.entries(
        decl.getBindingIdentifierPaths(),
      ): Array<[string, any]>)) {
        removeReplaceBinding(path.scope, name, next);
      }
    }
  } else {
    path.unshiftContainer('body', [t.expressionStatement(expression)]);
  }
}

export function generateExternalImport(
  bundle: Bundle,
  external: ExternalModule,
  path: NodePath<Program>,
) {
  let {scope} = path;

  let {source, specifiers, isCommonJS} = external;
  let statements = [];
  let properties: Array<ObjectProperty> = [];
  let categories = new Set();
  for (let [imported, symbol] of specifiers) {
    if (imported === '*') {
      categories.add('namespace');
    } else if (imported === 'default') {
      categories.add('default');
    } else {
      categories.add('named');
      properties.push(
        t.objectProperty(
          t.identifier(imported),
          t.identifier(symbol),
          false,
          symbol === imported,
        ),
      );
    }
  }

  let specifiersWildcard = specifiers.get('*');
  let specifiersDefault = specifiers.get('default');

  // Attempt to combine require calls as much as possible. Namespace, default, and named specifiers
  // cannot be combined, so in the case where we have more than one type, assign the require() result
  // to a variable first and then create additional variables for each specifier based on that.
  // Otherwise, if just one category is imported, just assign and require all at once.
  if (categories.size > 1) {
    let name = scope.generateUid(source);
    statements.push(
      ASSIGN_TEMPLATE({
        SPECIFIERS: t.identifier(name),
        MODULE: REQUIRE_TEMPLATE({
          BUNDLE: t.stringLiteral(source),
        }),
      }),
    );

    if (specifiersWildcard) {
      let value = t.identifier(name);
      if (!isCommonJS) {
        value = NAMESPACE_TEMPLATE({
          NAMESPACE: t.objectExpression([]),
          MODULE: value,
        });
      }

      statements.push(
        ASSIGN_TEMPLATE({
          SPECIFIERS: t.identifier(specifiersWildcard),
          MODULE: value,
        }),
      );
    }

    if (specifiersDefault) {
      statements.push(
        ASSIGN_TEMPLATE({
          SPECIFIERS: t.identifier(specifiersDefault),
          MODULE: INTEROP_TEMPLATE({
            MODULE: t.identifier(name),
          }),
        }),
      );
    }

    if (properties.length > 0) {
      statements.push(
        ...generateDestructuringAssignment(
          bundle.env,
          properties,
          t.identifier(name),
          scope,
        ),
      );
    }
  } else if (specifiersDefault) {
    statements.push(
      ASSIGN_TEMPLATE({
        SPECIFIERS: t.identifier(specifiersDefault),
        MODULE: INTEROP_TEMPLATE({
          MODULE: REQUIRE_TEMPLATE({
            BUNDLE: t.stringLiteral(source),
          }),
        }),
      }),
    );
  } else if (specifiersWildcard) {
    let require = REQUIRE_TEMPLATE({
      BUNDLE: t.stringLiteral(source),
    });

    if (!isCommonJS) {
      require = NAMESPACE_TEMPLATE({
        NAMESPACE: t.objectExpression([]),
        MODULE: require,
      });
    }

    statements.push(
      ASSIGN_TEMPLATE({
        SPECIFIERS: t.identifier(specifiersWildcard),
        MODULE: require,
      }),
    );
  } else if (properties.length > 0) {
    statements.push(
      ...generateDestructuringAssignment(
        bundle.env,
        properties,
        REQUIRE_TEMPLATE({
          BUNDLE: t.stringLiteral(source),
        }),
        scope,
      ),
    );
  } else {
    // TODO missing test coverage
    statements.push(
      t.expressionStatement(
        REQUIRE_TEMPLATE({
          BUNDLE: t.stringLiteral(source),
        }),
      ),
    );
  }

  let decls = path.unshiftContainer('body', statements);
  for (let decl of decls) {
    let next = decl.get('declarations.0');
    for (let [name] of (Object.entries(decl.getBindingIdentifierPaths()): Array<
      [string, any],
    >)) {
      if (path.scope.hasOwnBinding(name)) {
        removeReplaceBinding(path.scope, name, next);
      } else {
        path.scope.registerDeclaration(next);
      }
    }

    if (
      t.isCallExpression(next.node.init) &&
      !t.isIdentifier(next.node.init.callee, {name: 'require'})
    ) {
      // $parcel$exportWildcard or $parcel$interopDefault
      let id = next.get('init.callee');
      nullthrows(path.scope.getBinding(id.node.name)).reference(id);
    }
  }
}

export function generateExports(
  bundleGraph: BundleGraph,
  bundle: Bundle,
  referencedAssets: Set<Asset>,
  path: any,
  replacements: Map<Symbol, Symbol>,
  options: PluginOptions,
) {
  let exported = new Set<Symbol>();
  let statements: Array<ExpressionStatement> = [];

  for (let asset of referencedAssets) {
    let exportsId = asset.meta.exportsIdentifier;
    invariant(typeof exportsId === 'string');
    exported.add(exportsId);

    statements.push(
      EXPORT_TEMPLATE({
        NAME: t.identifier(exportsId),
        IDENTIFIER: t.identifier(exportsId),
      }),
    );
  }

  let entry = bundle.getMainEntry();
  if (entry) {
    if (entry.meta.isCommonJS) {
      let exportsId = entry.meta.exportsIdentifier;
      invariant(typeof exportsId === 'string');

      let binding = path.scope.getBinding(exportsId);
      if (binding) {
        // If the exports object is constant, then we can just remove it and rename the
        // references to the builtin CommonJS exports object. Otherwise, assign to module.exports.
        let init = binding.path.node.init;
        let isEmptyObject =
          init && t.isObjectExpression(init) && init.properties.length === 0;
        if (binding.constant && isEmptyObject) {
          for (let path of binding.referencePaths) {
            path.node.name = 'exports';
          }

          binding.path.remove();
          exported.add('exports');
        } else {
          exported.add(exportsId);
          statements.push(
            MODULE_EXPORTS_TEMPLATE({
              IDENTIFIER: t.identifier(exportsId),
            }),
          );
        }
      }
    } else {
      for (let {exportSymbol, symbol, asset} of bundleGraph.getExportedSymbols(
        entry,
      )) {
        if (!symbol) {
          let relativePath = relative(options.inputFS.cwd(), asset.filePath);
          throw new ThrowableDiagnostic({
            diagnostic: {
              message: `${relativePath} does not export '${exportSymbol}'`,
              filePath: entry.filePath,
              // TODO: add codeFrames (actual and reexporting asset) when AST from transformers is reused
            },
          });
        }

        symbol = replacements.get(symbol) || symbol;

        // If there is an existing binding with the exported name (e.g. an import),
        // rename it so we can use the name for the export instead.
        if (path.scope.hasBinding(exportSymbol) && exportSymbol !== symbol) {
          // TODO missing test coverage
          rename(
            path.scope,
            exportSymbol,
            path.scope.generateUid(exportSymbol),
          );
        }

        let binding = path.scope.getBinding(symbol);
        let id = !t.isValidIdentifier(exportSymbol)
          ? path.scope.generateUid(exportSymbol)
          : exportSymbol;
        rename(path.scope, symbol, id);

        let [stmt] = binding.path.getStatementParent().insertAfter(
          EXPORT_TEMPLATE({
            NAME: t.identifier(exportSymbol),
            IDENTIFIER: t.identifier(id),
          }),
        );
        binding.reference(stmt.get<Identifier>('expression.right'));

        // Exports other than the default export are live bindings. Insert an assignment
        // after each constant violation so this remains true.
        if (exportSymbol !== 'default') {
          // TODO missing test coverage
          for (let path of binding.constantViolations) {
            let [stmt] = path.insertAfter(
              EXPORT_TEMPLATE({
                NAME: t.identifier(exportSymbol),
                IDENTIFIER: t.identifier(id),
              }),
            );
            binding.reference(stmt.get<Identifier>('expression.right'));
          }
        }
      }
    }
  }

  let stmts: Array<NodePath<ExpressionStatement>> = path.pushContainer(
    'body',
    statements,
  );
  for (let stmt of stmts) {
    let id = stmt.get<NodePath<Identifier>>('expression.right');
    path.scope.getBinding(id.node.name).reference(id);
  }

  return exported;
}
