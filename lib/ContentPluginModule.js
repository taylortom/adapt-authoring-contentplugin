import AbstractApiModule from 'adapt-authoring-api';
import AdaptCli from 'adapt-cli';
import fs from 'fs-extra';
import globCallback from 'glob';
import path from 'path';
import semver from 'semver';
import zipper from 'zipper';
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
      await this.installPlugins();
      await this.processPluginSchemas();
    } catch(e) {
      this.log('error', e);
    }
  }
  /**
   * Installs all framework plugins specified in adapt.json
   * @return {Promise}
   */
  async installPlugins() {
    const managedDeps = Object.entries((await fs.readJSON(`${this.framework.path}/adapt.json`)).dependencies);
    const dbPlugins = (await this.find()).reduce((m,p) => Object.assign(m, { [p.name]: p }), {});
    const toInstall = []; 
    // check all specified plugins are installed in the local framework, if not mark for reinstall
    for(const [name, version] of managedDeps) {
      const p = dbPlugins[name];
      if(!p) { // plugin not in DB, mark for cli install
        toInstall.push([name, version]);
        continue;
      }
      try {  // check plugin exists in framework, reinstall if necessary
        const { version: localVersion } = (await fs.readJSON(`${this.framework.getPluginPath(p.type)}/${name}/bower.json`));
        if(localVersion !== p.version) {
          this.log('warn', `local framework copy of ${name} (${localVersion}) does not match DB version ${p.version}, please reinstall`);
        }
      } catch {
        toInstall.push([name, p.version]);
      }
    } // Check the locally installed plugins
    await Promise.all(Object.values(dbPlugins).filter(p => p.isLocalInstall).map(async p => {
      const cachePath = `${this.locaPluginsDir}/${p.name}`;
      if(!await fs.pathExists(cachePath)) {
        return this.log('error', `plugin ${p.name} exists in the DB but doesn't have local source files, please reinstall`);
      }
      try {
        await this.checkCompatibility(p);
        await fs.copy(cachePath, `${this.framework.getPluginPath(p.type)}/${p.name}`);
      } catch(e) {
        if(e.code !== 'CONTENTPLUGIN_ALREADY_EXISTS') this.log('error', `couldn't reinstall locally installed plugin ${p.name}, ${e.message}`);
      }
    }));
    for(const [name, version] of toInstall) {
      try {
        await this.installPlugin(name, version);
        this.newPlugins.push(name);
        this.log('debug', `successfully installed ${name}@${version}`);
      } catch(e) {
        if(e.code !== 'CONTENTPLUGIN_ALREADY_EXISTS') this.log('warn', `couldn't install ${name}@${version}, ${e.message}`);
      }
    }
  }
  /**
   * Loads and processes all installed content plugin schemas
   * @return {Promise}
   */
  async processPluginSchemas() {
    const jsonschema = await this.app.waitForModule('jsonschema');
    const installedPlugins = await this.find();
    return Promise.all(installedPlugins.map(async p => {
      const cwd = `${this.framework.getPluginPath(p.type)}/${p.name}`;
      const pluginSchemas = await globPromise(`schema/*.schema.json`, { cwd, absolute: true });
      if(!pluginSchemas.length) {
        return;
      }
      const schemas = await Promise.all(pluginSchemas.map(s => fs.readJson(s)));
      schemas.forEach((s,i) => {
        const source = s?.$patch?.source?.$ref;
        if(source) {
          if(!this.pluginSchemas[p.name]) this.pluginSchemas[p.name] = {};
          if(!this.pluginSchemas[p.name][source]) this.pluginSchemas[p.name][source] = [];
          this.pluginSchemas[p.name][source].push(s);
        }
        if(this.newPlugins.includes(p.name)) {
          jsonschema.registerSchema(pluginSchemas[i]);
        }
      });
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
   * Express request handler for installing a plugin
   * @param {ClientRequest} req
   * @param {ServerResponse} res
   * @param {Function} next
   */
  async installHandler(req, res, next) {
    try {
      const pluginData = req.body.name ?
        await this.installPlugin(req.body.name) :
        await this.manualInstallPlugin(req.fileUpload.files.file.filepath, { isZip: false });
      res.status(this.mapStatusCode('post')).send(pluginData);
    } catch(error) {
      return next(error);
    }
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
   * Installs a new plugin
   * @param {String} plugin Plugin name
   * @param {String} version Version to install as a semver
   */
  async installPlugin(plugin, version) {
    const pluginStr = `${plugin}${version === '*' ? '' : `@${version}`}`;
    const pluginData = this.addType(await this.runCliTask('install', pluginStr));
    pluginData.isLocalInstall = false;
    return this.insertToDatabase(pluginData);
  }
  /**
   * Installs a new plugin from a zip file
   * @param {String} zipPath Path to the zip file
   * @param {Object} options Whether
   * @param {Boolean} options.isZip Whether the passed path points to a zip file
   */
  async manualInstallPlugin(zipPath, options = { isZip: true }) {
    let unzipPath;
    let pluginSrc = zipPath;
    try {
      if(options.isZip) {
        unzipPath = await zipper.unzip(zipPath);
        pluginSrc = `${unzipPath}/${path.basename(zipPath, '.zip')}`;
      }
      // allow for zips with a nested root folder like GitHub provides
      const contents = await fs.readdir(pluginSrc);
      let rootDir = pluginSrc;
      if(contents.length === 1) {
        rootDir += `/${contents[0]}`; 
      }
      const pluginData = this.addType(await fs.readJson(`${rootDir}/bower.json`));
      const pluginPath = this.framework.getPluginPath(pluginData.type);
      const pluginDest = `${pluginPath}/${pluginData.name}`;

      pluginData.isLocalInstall = true;

      await this.checkCompatibility(pluginData);

      if(pluginSrc !== pluginDest) await fs.move(pluginSrc, pluginDest, { overwrite: true });
      // make sure a copy is saved in the pluginInstallDir
      await fs.copy(pluginDest, `${this.getConfig('pluginInstallDir')}/${pluginData.name}`);

      return this.insertToDatabase(pluginData);
    } catch(error) {
      try {
        if(options.isZip) await Promise.all([ fs.remove(unzipPath), fs.remove(pluginSrc) ]);
      } catch(removeError) {
        this.log('debug', removeError);
      }
      throw error;
    }
  }
  /**
   * Updates a single plugin
   * @param {String} _id The _id for the plugin to update
   */
  async updatePlugin(_id) {
    const installedPluginData = await this.getPluginById(_id);
    const pluginData = await this.runCliTask('update', installedPluginData.name);
    return this.replace({_id }, this.addType(pluginData));
  }
  /**
   * Removes a single plugin
   * @param {String} _id The _id for the plugin to remove
   */
  async uninstallPlugin(_id) {
    const pluginData = await this.getPluginById(_id);
    await this.delete({ _id });
    return this.runCliTask('uninstall', pluginData.name);
  }
  /**
   * Runs an adapt-cli task
   * @param {String} task Name of the CLI task to run
   * @param {String} plugin Name of the plugin on which to run the task
   */
  async runCliTask(task, plugin) {
    return AdaptCli[task]({ plugins: [plugin], cwd: this.framework.path });
  }
  /**
   * Inserts plugin data to the database
   * @param {Object} pluginData The data to be inserted into the DB
   */
  async insertToDatabase(pluginData) {
    const [ existingData ] = await this.find({ name: pluginData.name });
    if(existingData) {
      return this.replace({ name: pluginData.name }, pluginData);
    }
    return this.insert(pluginData);
  }
  /**
   * Retrieves a the database doc for a single plugin
   * @param {String} _id The _id for the plugin to retrieve
   */
  async getPluginById(_id) {
    const [ pluginData ] = await this.find({ _id });
    return pluginData;
  }
  /**
   * Sets the plugin type for the passed plugin data
   * @param {Object} pluginData The data to modify
   * @return {Object} the modified plugin data
   */
  addType(pluginData) {
    if(!pluginData.type) {
      pluginData.type = Object.keys(pluginData).find(key => ['component', 'extension', 'menu', 'theme'].includes(key));
    }
    return pluginData;
  }
  /**
   * Checks that a plugin is compatible with the currently installed framework
   * @param {Object} pluginData
   * @param {String} pluginData.name
   * @param {String} pluginData.version
   * @param {String} pluginData.framework
   * @param {String} pluginData.targetAttribute
   */
  async checkCompatibility({ name, version, framework, targetAttribute }) {
    const [ installedPluginData ] = await this.find({ name });

    if(installedPluginData && semver.eq(installedPluginData.version, version)) {
      throw this.app.errors.CONTENTPLUGIN_ALREADY_EXISTS.setData({ name, version });
    }
    if(installedPluginData && semver.gt(installedPluginData.version, version)) {
      throw this.app.errors.CONTENTPLUGIN_NEWER_INSTALLED.setData({ name, newVersion, existingVersion: installedPluginData.version });
    }
    if(!semver.satisfies(this.framework.version, framework)) {
      throw this.app.errors.CONTENTPLUGIN_INCOMPAT_FW.setData({ name, version, requiredFramework: framework, installedFramework: this.framework.version });
    }
    if(!targetAttribute) {
      throw this.app.errors.CONTENTPLUGIN_ATTR_MISSING.setData({ name });
    }
    const [ conflictingPlugin ] = await this.find({ targetAttribute, name: { $ne: name } });
    if(conflictingPlugin) {
      throw this.app.errors.CONTENTPLUGIN_ATTR_CLASH.setData({ name: conflictingPlugin.name, targetAttribute });
    }
  }
}

export default ContentPluginModule;