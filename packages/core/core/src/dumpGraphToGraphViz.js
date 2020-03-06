// @flow
/* global globalThis:readonly */

import type {Environment} from './types';

import type Graph from './Graph';
import type {AssetGraphNode, BundleGraphNode} from './types';

import path from 'path';
import {Graph as GraphVizGraph} from 'graphviz/lib/deps/graph';

const COLORS = {
  root: 'gray',
  asset: 'green',
  dependency: 'orange',
  transformer_request: 'cyan',
  file: 'gray',
  default: 'white',
};

const TYPE_COLORS = {
  bundle: 'blue',
  contains: 'grey',
  references: 'red',
};

export default function dumpGraphToGraphViz(
  // $FlowFixMe
  graph: Graph<AssetGraphNode> | Graph<BundleGraphNode>,
  name: string,
): void {
  if (
    process.env.PARCEL_BUILD_ENV === 'production' &&
    process.env.PARCEL_DUMP_GRAPHVIZ == null &&
    // $FlowFixMe
    globalThis.PARCEL_DUMP_GRAPHVIZ == null &&
    // $FlowFixMe
    !process.browser
  ) {
    return;
  }
  let g = new GraphVizGraph(null, 'G');
  g.type = 'digraph';

  let nodes = Array.from(graph.nodes.values());
  for (let node of nodes) {
    let n = g.addNode(node.id);
    // $FlowFixMe default is fine. Not every type needs to be in the map.
    n.set('color', COLORS[node.type || 'default']);
    n.set('shape', 'box');
    n.set('style', 'filled');
    let label = `${node.type || 'No Type'}: [${node.id}]: `;
    if (node.type === 'dependency') {
      label += node.value.moduleSpecifier;
      let parts = [];
      if (node.value.isEntry) parts.push('entry');
      if (node.value.isAsync) parts.push('async');
      if (node.value.isWeak) parts.push('weak');
      if (node.value.isOptional) parts.push('optional');
      if (node.value.isDeferred) parts.push('deferred');
      if (parts.length) label += ' (' + parts.join(', ') + ')';
      if (node.value.env) label += ` (${getEnvDescription(node.value.env)})`;
    } else if (node.type === 'asset') {
      label += path.basename(node.value.filePath) + '#' + node.value.type;
    } else if (node.type === 'asset_group') {
      if (node.deferred) label += '(deferred)';
    } else if (node.type === 'file') {
      label += path.basename(node.value.filePath);
    } else if (node.type === 'transformer_request') {
      label +=
        path.basename(node.value.filePath) +
        ` (${getEnvDescription(node.value.env)})`;
    } else if (node.type === 'bundle') {
      let parts = [];
      if (node.value.isEntry) parts.push('entry');
      if (node.value.isInline) parts.push('inline');
      if (parts.length) label += ' (' + parts.join(', ') + ')';
      if (node.value.env) label += ` (${getEnvDescription(node.value.env)})`;
    } else if (node.type === 'request') {
      label = node.value.type + ':' + node.id;
    }
    n.set('label', label);
  }
  for (let edge of graph.getAllEdges()) {
    let gEdge = g.addEdge(edge.from, edge.to);
    let color = edge.type != null ? TYPE_COLORS[edge.type] : null;
    if (color != null) {
      gEdge.set('color', color);
    }
  }
  // $FlowFixMe
  if (process.browser) {
    console.groupCollapsed(`Graph ${name}`);
    console.log(g.to_dot());
    console.groupEnd();
  } else {
    // const tempy = require('tempy');
    // let tmp = tempy.file({name: `${name}.png`});
    // await g.output('png', tmp);
    // eslint-disable-next-line no-console
    // console.log('Dumped', tmp);
  }
}

function getEnvDescription(env: Environment) {
  let description;
  if (typeof env.engines.browsers === 'string') {
    description = `${env.context}: ${env.engines.browsers}`;
  } else if (Array.isArray(env.engines.browsers)) {
    description = `${env.context}: ${env.engines.browsers.join(', ')}`;
  } else if (env.engines.node) {
    description = `node: ${env.engines.node}`;
  }

  return description ?? '';
}
