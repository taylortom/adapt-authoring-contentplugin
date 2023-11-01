export default {
  update: {
    post: {
      summary: 'Update a single content plugin',
      parameters: [{ name: '_id', in: 'path', description: 'Content plugin _id', required: true }],
      responses: {
        200: {
          description: '',
          content: {
            'application/json': {
              schema: { $ref: '#components/schemas/contentplugin' }
            }
          }
        }
      }
    }
  },
  uses: {
    get: {
      summary: 'Return courses using a single content plugin',
      parameters: [{ name: '_id', in: 'path', description: 'Content plugin _id', required: true }],
      responses: {
        200: {
          description: '',
          content: {
            'application/json': {
              schema: {
                type: 'array',
                items: { $ref: '#components/schemas/course' }
              }
            }
          }
        }
      }
    }
  },
  install: {
    post: {
      summary: 'Import an Adapt course',
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $schema: 'https://json-schema.org/draft/2020-12/schema',
              type: 'object',
              properties: {
                name: { type: 'string' },
                version: { type: 'string' },
                force: { type: 'Boolean', default: false }
              }
            }
          }
        }
      },
      responses: {
        200: {
          description: '',
          content: {
            'application/json': {
              schema: { $ref: '#components/schemas/contentplugin' }
            }
          }
        }
      }
    }
  }
}
