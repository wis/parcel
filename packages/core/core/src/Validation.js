// @flow strict-local

import type {WorkerApi} from '@parcel/workers';
import type {
  AssetRequestDesc,
  ConfigRequestDesc,
  ParcelOptions,
  ReportFn,
} from './types';
import type {Validator, ValidateResult} from '@parcel/types';

import path from 'path';
import {resolveConfig} from '@parcel/utils';
import logger, {PluginLogger} from '@parcel/logger';
import ThrowableDiagnostic, {errorToDiagnostic} from '@parcel/diagnostic';
import ParcelConfig from './ParcelConfig';
import ConfigLoader from './ConfigLoader';
import InternalAsset, {createAsset} from './InternalAsset';
import {Asset} from './public/Asset';
import PluginOptions from './public/PluginOptions';
import summarizeRequest from './summarizeRequest';

export type ValidationOpts = {|
  config: ParcelConfig,
  /**
   * If true, this Validation instance will run all validators that implement the single-threaded "validateAll" method.
   * If falsy, it will run validators that implement the one-asset-at-a-time "validate" method.
   */
  dedicatedThread?: boolean,
  options: ParcelOptions,
  requests: AssetRequestDesc[],
  report: ReportFn,
  workerApi?: WorkerApi,
|};

export default class Validation {
  allAssets: {[validatorName: string]: InternalAsset[], ...} = {};
  allValidators: {[validatorName: string]: Validator, ...} = {};
  dedicatedThread: boolean;
  configRequests: Array<ConfigRequestDesc>;
  configLoader: ConfigLoader;
  impactfulOptions: $Shape<ParcelOptions>;
  options: ParcelOptions;
  parcelConfig: ParcelConfig;
  report: ReportFn;
  requests: AssetRequestDesc[];
  workerApi: ?WorkerApi;

  constructor({
    config,
    dedicatedThread,
    options,
    requests,
    report,
    workerApi,
  }: ValidationOpts) {
    this.configLoader = new ConfigLoader({options, config});
    this.dedicatedThread = dedicatedThread ?? false;
    this.options = options;
    this.parcelConfig = config;
    this.report = report;
    this.requests = requests;
    this.workerApi = workerApi;
  }

  async run(): Promise<void> {
    let pluginOptions = new PluginOptions(this.options);
    await this.buildAssetsAndValidators();
    await Promise.all(
      Object.keys(this.allValidators).map(async validatorName => {
        let assets = this.allAssets[validatorName];
        if (assets) {
          let plugin = this.allValidators[validatorName];
          let validatorLogger = new PluginLogger({origin: validatorName});
          try {
            // If the plugin supports the single-threading validateAll method, pass all assets to it.
            if (plugin.validateAll && this.dedicatedThread) {
              let validatorResults = await plugin.validateAll({
                assets: assets.map(asset => new Asset(asset)),
                options: pluginOptions,
                logger: validatorLogger,
                resolveConfigWithPath: (
                  configNames: Array<string>,
                  assetFilePath: string,
                ) =>
                  resolveConfig(
                    this.options.inputFS,
                    assetFilePath,
                    configNames,
                  ),
              });
              for (let validatorResult of validatorResults) {
                this.handleResult(validatorResult);
              }
            }

            // Otherwise, pass the assets one-at-a-time
            else if (plugin.validate && !this.dedicatedThread) {
              await Promise.all(
                assets.map(async asset => {
                  let config = null;
                  if (plugin.getConfig) {
                    config = await plugin.getConfig({
                      asset: new Asset(asset),
                      options: pluginOptions,
                      logger: validatorLogger,
                      resolveConfig: (configNames: Array<string>) =>
                        resolveConfig(
                          this.options.inputFS,
                          asset.value.filePath,
                          configNames,
                        ),
                    });
                  }

                  let validatorResult = await plugin.validate({
                    asset: new Asset(asset),
                    options: pluginOptions,
                    config,
                    logger: validatorLogger,
                  });
                  this.handleResult(validatorResult);
                }),
              );
            }
          } catch (e) {
            throw new ThrowableDiagnostic({
              diagnostic: errorToDiagnostic(e, validatorName),
            });
          }
        }
      }),
    );
  }

  async buildAssetsAndValidators() {
    // Figure out what validators need to be run, and group the assets by the relevant validators.
    await Promise.all(
      this.requests.map(async request => {
        this.report({
          type: 'validation',
          filePath: request.filePath,
        });

        let asset = await this.loadAsset(request);

        let validators = await this.parcelConfig.getValidators(
          request.filePath,
        );

        for (let validator of validators) {
          this.allValidators[validator.name] = validator.plugin;
          if (this.allAssets[validator.name]) {
            this.allAssets[validator.name].push(asset);
          } else {
            this.allAssets[validator.name] = [asset];
          }
        }
      }),
    );
  }

  handleResult(validatorResult: ?ValidateResult) {
    if (validatorResult) {
      let {warnings, errors} = validatorResult;

      if (errors.length > 0) {
        throw new ThrowableDiagnostic({
          diagnostic: errors,
        });
      }

      if (warnings.length > 0) {
        logger.warn(warnings);
      }
    }
  }

  async loadAsset(request: AssetRequestDesc): Promise<InternalAsset> {
    let {filePath, env, code, sideEffects} = request;
    let {content, size, hash, isSource} = await summarizeRequest(
      this.options.inputFS,
      request,
    );

    // If the transformer request passed code rather than a filename,
    // use a hash as the base for the id to ensure it is unique.
    let idBase =
      code != null
        ? hash
        : path
            .relative(this.options.projectRoot, filePath)
            .replace(/[\\/]+/g, '/');
    return new InternalAsset({
      idBase,
      value: createAsset({
        idBase,
        filePath: filePath,
        isSource,
        type: path.extname(filePath).slice(1),
        hash,
        env: env,
        stats: {
          time: 0,
          size,
        },
        sideEffects: sideEffects,
      }),
      options: this.options,
      content,
    });
  }
}
