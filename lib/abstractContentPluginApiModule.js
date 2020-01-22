const AbstractApiModule = require('adapt-authoring-api');
const fs = require('fs');
const { promisify } = require('util');
const { DataQuery, Responder } = require('adapt-authoring-core');
/**
* Abstract module which handles framework plugins
* @extends {AbstractApiModule}
*/
class AbstractContentPluginApiModule extends AbstractApiModule {
  /** @override */
  async setValues() {
    const contentplugin = await this.app.waitForModule('contentplugin');
    const framework = await this.app.waitForModule('adaptFramework');

    this.framework_dir = framework.framework_dir;
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
      const data = await this.installPlugin(req.body.name);
      // alternative manual upload steps:
      // unzip uploaded plugin and move to this.framework_dir
      // req.body = plugin's parsed bower.json
      // add plugin to adapt.json
      responder.success(data, { statusCode: Responder.StatusCodes.Success.post });
    } catch (error) {
      next(error);
    }
  }

  async uninstallHandler(req, res, next) {
    const responder = new Responder(res);

    try {
      await this.uninstallPlugin(this.root, req.params._id);
      responder.success(null, { statusCode: Responder.StatusCodes.Success.delete });
    } catch (error) {
      next(error);
    }
  }

  async installPlugin(plugin) {
    const pluginData = await this.runCliTask('install', plugin);
    const mongodb = await this.app.waitForModule('mongodb');

    const pluginType = Object.keys(pluginData).find(key => {
      return [ 'component', 'extension', 'menu', 'theme' ].includes(key);
    });

    return await mongodb.create({ ...pluginData, type: pluginType });
  }

  async uninstallPlugin(type, id) {
    const mongodb = await this.app.waitForModule('mongodb');
    const query = new DataQuery({ type, fieldsMatching: { _id: id } });
    const [ pluginData ] = await mongodb.retrieve(query);

    await mongodb.delete(query);

    return await this.runCliTask('uninstall', pluginData.name);
  }

  async runCliTask(task, plugin) {
    // dummy filesystem operations for now
    switch (task) {
      case 'install':
        await promisify(fs.mkdir)(`${this.framework_dir}/src/extensions/${plugin}`, {
          recursive: true
        });

        return { name: plugin, extension: `adapt-${plugin}` };
      case 'uninstall':
        return promisify(fs.rmdir)(`${this.framework_dir}/src/extensions/${plugin}`);
    }
  }
}

module.exports = AbstractContentPluginApiModule;
