const { AbstractModule, Responder, Utils } = require('adapt-authoring-core');
/**
* Module which handles framework plugins
* @extends {AbstractModule}
*/
class ContentPluginModule extends AbstractModule {
  /** @override */
  preload(app, resolve, reject) {
    const router = app.getModule('server').api.createChildRouter('contentplugin');

    Utils.defineGetter(this, 'router', router);
    app.auth.secureRoute(`${this.router.path}/`, 'GET', [ 'read:contentplugin' ]);
    this.router.enableAPIMap();
    resolve();
  }
}

module.exports = ContentPluginModule;
