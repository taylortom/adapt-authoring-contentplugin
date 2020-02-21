const AbstractApiModule = require('adapt-authoring-api');
const { Responder } = require('adapt-authoring-core');
const cli = require('adapt-cli').api.commands;
const fs = require('fs-extra');
const path = require('path');
const semver = require('semver');
const zipper = require('zipper');
/**
* Abstract module which handles framework plugins
* @extends {AbstractApiModule}
*/
class AbstractContentPluginApiModule extends AbstractApiModule {
  /** @override */
  async setValues() {
    const contentplugin = await this.app.waitForModule('contentplugin');

    this.db = await this.app.waitForModule('mongodb');
    this.framework = await this.app.waitForModule('adaptFramework');
    this.pluginsPath = this.framework.getPluginPath(this.root);
    this.router = contentplugin.router.createChildRouter(this.root);

    this.routes = [
      { route: '/install', handlers: { post: this.installHandler.bind(this) } },
      { route: '/:_id/update', handlers: { post: this.updateHandler.bind(this) } },
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

  async updateHandler(req, res, next) {
    const responder = new Responder(res);

    try {
      const pluginData = await this.updatePlugin(req.params._id);
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
        await Promise.all([ fs.remove(unzipPath), fs.remove(pluginSrc) ]);
      } catch (removeError) {
        this.log('debug', removeError);
      }

      throw error;
    }
  }

  async updatePlugin(id) {
    const installedPluginData = await this.getPluginById(id);
    const pluginData = await this.runCliTask('update', installedPluginData.name);

    return await this.replace(this.collectionName, { _id: id }, pluginData);
  }

  async uninstallPlugin(id) {
    const pluginData = await this.getPluginById(id);

    await this.db.delete(this.collectionName, { _id: id });

    return await this.runCliTask('uninstall', name);
  }

  async runCliTask(task, plugin) {
    return await cli[task](plugin, this.framework.path);
  }

  async writeToDatabase(pluginData) {
    return await this.db.insert(this.collectionName, pluginData);
  }

  async getPluginById(id) {
    const [ pluginData ] = await this.db.find(this.collectionName, { _id: id });

    return pluginData;
  }

  // not needed?
  getPluginType(pluginData) {
    // return pluginData.type;
    return Object.keys(pluginData).find(key => {
      return [ 'component', 'extension', 'menu', 'theme' ].includes(key);
    });
  }

  async checkCompatibility({ name, version, framework, targetAttribute }) {
    const [ installedPluginData ] = await this.db.find(this.collectionName, { name });

    if (installedPluginData && semver.eq(installedPluginData.version, version)) {
        throw new Error('Plugin version already exists');
    }

    const [ conflictingPlugin ] = await this.db.find(this.collectionName, {
      targetAttribute,
      name: { $ne: name }
    });

    if (conflictingPlugin) {
      throw new Error(`Target attribute already exists in ${conflictingPlugin.name}`);
    }

    if (!semver.satisfies(this.framework.version, framework)) {
      throw new Error('Plugin incompatible with installed framework');
    }
  }
}

module.exports = AbstractContentPluginApiModule;
