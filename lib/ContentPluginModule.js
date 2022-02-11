import AbstractApiModule from 'adapt-authoring-api';
import AdaptCli from 'adapt-cli';
import fs from 'fs-extra';
import globCallback from 'glob';
import path from 'path';
import util from 'util';

/** @ignore */ const globPromise = util.promisify(globCallback);
/**
 * Abstract module which handles framework plugins
 * @extends {AbstractApiModule}
 */
class ContentPluginModule extends AbstractApiModule {
  /** @override */
  async setValues() {
    /** @ignore */ this.collectionName = 'contentplugins';
    /** @ignore */ this.root = 'contentplugins';
    /** @ignore */ this.schemaName = 'contentplugin';
    /**
     * Reference to all content plugin schemas
     * @type {Array}
     */
    this.pluginSchemas = [];
    /**
     * A list of newly installed plugins
     * @type {Array}
     */
    this.newPlugins = [];

    const middleware = await this.app.waitForModule('middleware');

    /** @ignore */ this.routes = [
      {
        route: '/install',
        handlers: { post: [
          middleware.fileUploadParser('application/zip', { unzip: true }),
          this.installHandler.bind(this)
        ] },
        permissions: { post: ['install:contentplugin'] },
        validate: false
      },
      {
        route: '/query',
        handlers: { post: this.queryHandler() },
        permissions: { post: ['read:contentplugin'] },
        validate: false
      },
      {
        route: '/schema',
        handlers: { get: this.serveSchema() },
        permissions: { get: ['read:schema'] }
      },
      {
        route: '/:_id/update',
        handlers: { post: this.updateHandler.bind(this) },
        permissions: { post: ['update:contentplugin'] }
      },
      {
        route: '/:_id/uninstall',
        handlers: { post: this.uninstallHandler.bind(this) },
        permissions: { post: ['install:contentplugin'] }
      },
      {
        route: '/:_id/uses',
        handlers: { get: this.usesHandler.bind(this) },
        permissions: { get: ['read:contentplugin'] }
      },
      {
        route: '/:_id?',
        handlers: { get: this.requestHandler() },
        permissions: { get: ['read:contentplugin'] }
      },
      {
        route: '/:_id',
        handlers: { patch: this.requestHandler() },
        permissions: { patch: ['write:contentplugin'] }
      }
    ];
  }
  /** @override */
  async init() {
    await super.init();

    const [framework, mongodb] = await this.app.waitForModule('adaptframework', 'mongodb');

    mongodb.setIndex(this.collectionName, 'name', { unique: true });
    /**
     * Cached module instance for easy access
     * @type {AdaptFrameworkModule}
     */
    this.framework = framework;
    /**
     * Directory locally-installed plugins are stored
     * @type {String}
     */
    this.locaPluginsDir = path.resolve(this.app.rootDir, this.getConfig('pluginInstallDir'));
    try {
      await fs.ensureDir(this.locaPluginsDir);
      await this.initPlugins();
      await this.processPluginSchemas();
    } catch(e) {
      this.log('error', e);
    }
  }
  /**
   * Initialises all framework plugins, from adapt.json and local cache
   * @return {Promise}
   */
  async initPlugins() {
    const cliOpts = { cwd: this.framework.path };
    const dbPlugins = await this.find();
    // no plugins in the DB, initialise using adapt.json
    if(!dbPlugins.length) {
      await this.installPlugins();
      return this.log('debug', 'contentplugins initialised from adapt.json');
    }
    const installedPlugins = (await AdaptCli.getPluginUpdateInfos(cliOpts)).reduce((m, p) => Object.assign(m, { [p.name]: p }), {});
    const toInstall = [];
    // make sure local src matches DB entries and try to reinitialise anything missing
    await Promise.all(dbPlugins.map(async p => {
      try {
        if(installedPlugins[p.name]?.projectVersion === p.version) {
          return; // already installed with the correct version
        }
        const dir = path.resolve(this.locaPluginsDir, p.name);
        await fs.stat(dir);
        toInstall.push(dir); // local cached copy exists, use that
      } catch(e) {
        toInstall.push(`${p.name}@${p.version}`); // no cached version, try the CLI's DB
      }
    }));
    if(!toInstall?.length) {
      return this.log('debug', 'no contentplugins to initialise');
    }
    await this.installPlugins(toInstall);
    this.log('debug', 'contentplugins initialised');
  }
  /**
   * Loads and processes all installed content plugin schemas
   * @return {Promise}
   */
  async processPluginSchemas() {
    const jsonschema = await this.app.waitForModule('jsonschema');
    const pluginInfo = await AdaptCli.getPluginUpdateInfos({ cwd: this.framework.path });
    Promise.all(pluginInfo.map(async plugin => {
      Promise.all((await plugin.getSchemaPaths()).map(async p => {
        const name = plugin.name;
        const s = await fs.readJSON(p);
        const source = s?.$patch?.source?.$ref;
        if(source) {
          if(!this.pluginSchemas[name]) this.pluginSchemas[name] = {};
          if(!this.pluginSchemas[name][source]) this.pluginSchemas[name][source] = [];
          this.pluginSchemas[name][source].push(s);
        }
        if(this.newPlugins.includes(name)) jsonschema.registerSchema(pluginSchemas[i]);
      }));
    }));
  }
  /**
   * Returns all extension schemas for a single plugin
   * @param {String} pluginName 
   * @param {String} sourceSchema 
   * @return {Array} The schemas
   */
  getPluginExtensionSchemas(pluginName, sourceSchema) {
    const schemas = this.pluginSchemas[pluginName] && this.pluginSchemas[pluginName][sourceSchema];
    return schemas ? schemas : [];
  }
  /**
   * Retrieves the courses in which a plugin is used
   * @param {String} pluginId Plugin _id
   * @returns {Promise} Resolves with an array of course data
   */
  async getPluginUses(pluginId) {
    const [{ name }] = await this.find({ _id: pluginId });
    const [content, db] = await this.app.waitForModule('content', 'mongodb');
    return (db.getCollection(content.collectionName).aggregate([
      { $match: { _type: 'config', _enabledPlugins: name } },
      { $lookup: { from: 'content', localField: '_courseId', foreignField: '_id', as: 'course' } },
      { $unwind: '$course' },
      { $replaceRoot: { newRoot: "$course" } },
      { $project: { 'title': 1 } }
    ])).toArray();
  }
  /**
   * Installs new plugins
   * @param {Array[String]} plugins Array of plugin either as name@version or a file path
   */
  async installPlugins(plugins) {
    const data = await AdaptCli.installPlugins({ plugins, cwd: this.framework.path });
    console.log('installPlugins', data);
    data.map(async d => this.insert({ ...await d.getInfo(), type: await d.getType(), isLocalInstall: d.isLocalSource }));
  }
  /**
   * Updates a single plugin
   * @param {String} _id The _id for the plugin to update
   */
  async updatePlugin(_id) {
    const [{ name }] = await this.find({ _id });
    const pluginData = await AdaptCli.updatePlugins({ plugins: [name], cwd: this.framework.path });
    return this.replace({ name }, pluginData);
  }
  /**
   * Removes a single plugin
   * @param {String} _id The _id for the plugin to remove
   */
  async uninstallPlugin(_id) {
    const [pluginData] = await this.find({ _id });
    await AdaptCli.uninstallPlugins({ plugins: [pluginData.name], cwd: this.framework.path });
    return this.delete({ _id });
  }
  /** @override */
  serveSchema() {
    return async (req, res, next) => {
      try {
        const plugin = await this.get({ name: req.apiData.query.type }) || {};
        const schema = await this.getSchema(plugin.schemaName);
        if(!schema) {
          return next(this.app.errors.NOT_FOUND.setData({ type: 'schema' }));
        }
        res.type('application/schema+json').json(schema);
      } catch(e) {
        return next(e);
      }
    };
  }
  /**
   * Express request handler for installing a plugin
   * @param {ClientRequest} req
   * @param {ServerResponse} res
   * @param {Function} next
   */
   async installHandler(req, res, next) {
    try {
      const name = req.body.name || req.fileUpload.files.file.filepath;
      const pluginData = await this.installPlugins([name]);
      res.status(this.mapStatusCode('post')).send(pluginData);
    } catch(error) {
      return next(error);
    }
  }
  /**
   * Express request handler for updating a plugin
   * @param {ClientRequest} req
   * @param {ServerResponse} res
   * @param {Function} next
   */
  async updateHandler(req, res, next) {
    try {
      const pluginData = await this.updatePlugin(req.params._id);
      res.status(this.mapStatusCode('put')).send(pluginData);
    } catch(error) {
      return next(error);
    }
  }
  /**
   * Express request handler for removing a plugin
   * @param {ClientRequest} req
   * @param {ServerResponse} res
   * @param {Function} next
   */
  async uninstallHandler(req, res, next) {
    try {
      await this.uninstallPlugin(req.params._id);
      res.status(this.mapStatusCode('delete')).end();
    } catch(error) {
      return next(error);
    }
  }
  /**
   * Express request handler for retrieving uses of a single plugin
   * @param {ClientRequest} req
   * @param {ServerResponse} res
   * @param {Function} next
   */
   async usesHandler(req, res, next) {
    try {
      const data = await this.getPluginUses(req.params._id);
      res.status(this.mapStatusCode('put')).send(data);
    } catch(error) {
      return next(error);
    }
  }
}

export default ContentPluginModule;