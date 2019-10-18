const AbstractApiModule = require('adapt-authoring-api');
const { Utils } = require('adapt-authoring-core');
/**
* Abstract module which handles framework plugins
* @extends {AbstractApiModule}
*/
class AbstractContentPluginApiModule extends AbstractApiModule {
  /** @override */
  static get def() {
    return {
      name: 'contentplugin',
      routes: [
        {
          route: '/:_id?',
          handlers: [ 'get', 'post', 'put', 'delete' ]
        }
      ]
    };
  }
  /** @override */
  preload(app, resolve, reject) {
    const contentplugin = this.app.getModule('contentplugin');
    contentplugin.on('preload', () => {
      /**
      * Router instance
      * @type {Router}
      */
      Utils.defineGetter(this, 'router', contentplugin.router.createChildRouter(this.constructor.def.name));
      this.initMiddleware();
      this.initRoutes();
      resolve();
    });
  }
}

module.exports = AbstractContentPluginApiModule;
