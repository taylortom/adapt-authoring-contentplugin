const AbstractApiModule = require('adapt-authoring-api');
const fs = require('fs');
const { promisify } = require('util');
const { Responder } = require('adapt-authoring-core');
/**
* Abstract module which handles framework plugins
* @extends {AbstractApiModule}
*/
class AbstractContentPluginApiModule extends AbstractApiModule {
  /** @override */
  async setValues() {
    const contentplugin = await this.app.waitForModule('contentplugin');

    this.router = contentplugin.router.createChildRouter(this.root);

    this.routes = [
      {
        route: '/install',
        handlers: {
          post: [ 
            this.installPlugin.bind(this),
            this.constructor.requestHandler()
          ]
        }
      },
      { route: '/:_id/uninstall', handlers: { post: this.uninstallPlugin.bind(this) } },
      { route: '/:_id?', handlers: { get: this.constructor.requestHandler() } }
    ];
  }

  async installPlugin(req, res, next) {
    try {
      // install using plugin name
      await this.runCliTask('install', req.body); 
      // alternative manual upload steps:
      // unzip uploaded plugin and move to temp dir
      // req.body = plugin's parsed bower.json
      // add plugin to adapt.json
      next();
    } catch (error) {
      next(error);
    }
  }

  async uninstallPlugin(req, res, next) {
    const customRes = new Responder(res);

    try {
      const mongodb = await this.app.waitForModule('mongodb');
      const [ pluginData ] = await mongodb.retrieve(req.dsquery);

      await mongodb.delete(req.dsquery);
      await this.runCliTask('uninstall', pluginData);
      customRes.success(null, { statusCode: Responder.StatusCodes.Success.delete });
    } catch (error) {
      next(error);
    }
  }

  runCliTask(task, { type, name }) {
    // dummy filesystem operations for now
    switch (task) {
      case 'install':
        return promisify(fs.mkdir)(`src/${type}/${name}`, { recursive: true });
      case 'uninstall':
        return promisify(fs.rmdir)(`src/${type}/${name}`);
    }
  }
}

module.exports = AbstractContentPluginApiModule;
