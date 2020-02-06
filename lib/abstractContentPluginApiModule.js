const AbstractApiModule = require('adapt-authoring-api');
const { Responder } = require('adapt-authoring-core');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);
const fs = require('fs-extra');
const path = require('path');
const semver = require('semver');
const zipper = require('zipper');

const Folders = {
  component: 'components',
  extension: 'extensions',
  menu: 'menu',
  theme: 'theme'
};
/**
* Abstract module which handles framework plugins
* @extends {AbstractApiModule}
*/
class AbstractContentPluginApiModule extends AbstractApiModule {
  /** @override */
  async setValues() {
    const contentplugin = await this.app.waitForModule('contentplugin');
    const framework = await this.app.waitForModule('adaptFramework');

    this.frameworkPath = framework.framework_dir;
    this.pluginsPath = `${this.frameworkPath}/src/${Folders[this.root]}`;
    this.router = contentplugin.router.createChildRouter(this.root);

    this.routes = [
      { route: '/install', handlers: { post: this.installHandler.bind(this) } },
      { route: '/:_id/uninstall', handlers: { post: this.uninstallHandler.bind(this) } },
      { route: '/:_id?', handlers: { get: this.requestHandler() } }
    ];
  }

  async installHandler(req, res, next) {
    const responder = new Responder(res);

    try {
      // mock zip attributes for now
      const pluginData = !req.body.isZip ?
        await this.installPlugin(req.body.name) :
        await this.manualInstallPlugin(req.body.zipPath);

      responder.success(pluginData, { statusCode: Responder.StatusCodes.Success.post });
    } catch (error) {
      next(error);
    }
  }

  async uninstallHandler(req, res, next) {
    const responder = new Responder(res);

    try {
      await this.uninstallPlugin(req.params._id);
      responder.success(null, { statusCode: Responder.StatusCodes.Success.delete });
    } catch (error) {
      next(error);
    }
  }

  async installPlugin(plugin) {
    const pluginData = await this.runCliTask('install', plugin);

    return await this.writeToDatabase(pluginData);
  }

  async manualInstallPlugin(zipPath) {
    let unzipPath;
    let pluginSrc;

    try {
      unzipPath = await zipper.unzip(zipPath);
      pluginSrc = `${unzipPath}/${path.basename(zipPath, '.zip')}`;

      const pluginData = await fs.readJson(`${pluginSrc}/bower.json`);
      const pluginDest = `${this.pluginsPath}/${pluginData.name}`;
      
      await this.checkCompatibility(pluginData);
      await fs.move(pluginSrc, pluginDest, { overwrite: true });

      return await this.writeToDatabase(pluginData);
    } catch (error) {
      try {
        await fs.remove(unzipPath);
        await fs.remove(pluginSrc);
      } catch (removeError) {
        this.log('debug', removeError);
      }

      throw error;
    }
  }

  async uninstallPlugin(id) {
    const mongodb = await this.app.waitForModule('mongodb');
    const params = [ this.collectionName, { _id: id } ];
    const [ { name } ] = await mongodb.find(...params);

    await mongodb.delete(...params);

    return await this.runCliTask('uninstall', name);
  }

  async runCliTask(task, plugin) {
    // shell cli operations for now
    let output;

    try {
      output = await exec(`adapt ${task} ${plugin}`, {
          cwd: this.frameworkPath,
          timeout: 20000
      });
    } catch ({ stdout, stderr }) {
      this.log('debug', '\n', stdout, stderr);

      const bowerPath = `${this.pluginsPath}/${plugin}/bower.json`;
      const pluginData = await fs.readJson(bowerPath);

      return pluginData;
    }

    this.log('debug', output.stdout, output.stderr);

    return output;
  }

  async writeToDatabase(pluginData) {
    const mongodb = await this.app.waitForModule('mongodb');

    return await mongodb.insert(this.collectionName, pluginData);
  }

  // not needed?
  getPluginType(pluginData) {
    // return pluginData.type;
    return Object.keys(pluginData).find(key => {
      return [ 'component', 'extension', 'menu', 'theme' ].includes(key);
    });
  }

  async checkCompatibility({ name, version, framework, targetAttribute }) {
    const mongodb = await this.app.waitForModule('mongodb');
    const [ installedPluginData ] = await mongodb.find(this.collectionName, { name });

    if (installedPluginData && semver.eq(installedPluginData.version, version)) {
        throw new Error('Plugin version already exists');
    }

    const [ conflictingPlugin ] = await mongodb.find(this.collectionName, {
      targetAttribute,
      name: { $ne: name }
    });

    if (conflictingPlugin) {
      throw new Error(`Target attribute already exists in ${conflictingPlugin.name}`);
    }

    const frameworkData = await fs.readJson(`${this.frameworkPath}/package.json`);

    if (!semver.satisfies(frameworkData.version, framework)) {
      throw new Error('Plugin incompatible with installed framework');
    }
  }
}

module.exports = AbstractContentPluginApiModule;
