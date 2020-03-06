// @flow

import type {Config} from '@parcel/types';
import type {BabelConfig} from './types';

import plugin from '@babel/plugin-transform-flow-strip-types';

/**
 * Generates a babel config for stripping away Flow types.
 */
export default function getFlowOptions(config: Config): ?BabelConfig {
  if (!config.isSource) {
    return null;
  }

  return {
    plugins: [[plugin, {requireDirective: true}]],
  };
}
