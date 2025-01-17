/*
 * Copyright 2022 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Knex } from 'knex';
import { Logger } from 'winston';
import { ConfigReader } from '@backstage/config';
import { JsonObject } from '@backstage/types';
import { CatalogProcessingEngine, EntityProvider } from './index';
import { DatabaseManager, getVoidLogger } from '@backstage/backend-common';
import { PermissionEvaluator } from '@backstage/plugin-permission-common';
import {
  Entity,
  EntityPolicies,
  stringifyEntityRef,
} from '@backstage/catalog-model';
import { defaultEntityDataParser } from './modules/util/parse';
import { DefaultCatalogProcessingOrchestrator } from './processing/DefaultCatalogProcessingOrchestrator';
import { applyDatabaseMigrations } from './database/migrations';
import { DefaultProcessingDatabase } from './database/DefaultProcessingDatabase';
import { ScmIntegrations } from '@backstage/integration';
import { DefaultCatalogRulesEnforcer } from './ingestion/CatalogRules';
import { Stitcher } from './stitching/Stitcher';
import { DefaultEntitiesCatalog } from './service/DefaultEntitiesCatalog';
import {
  DefaultCatalogProcessingEngine,
  ProgressTracker,
} from './processing/DefaultCatalogProcessingEngine';
import { createHash } from 'crypto';
import { DefaultRefreshService } from './service/DefaultRefreshService';
import { connectEntityProviders } from './processing/connectEntityProviders';
import { EntitiesCatalog } from './catalog/types';
import { RefreshOptions, RefreshService } from './service/types';
import {
  CatalogProcessorEmit,
  EntityProviderConnection,
  LocationSpec,
  processingResult,
} from '@backstage/plugin-catalog-node';
import { RefreshStateItem } from './database/types';

const voidLogger = getVoidLogger();

class TestProvider implements EntityProvider {
  #connection?: EntityProviderConnection;

  getProviderName(): string {
    return 'test';
  }

  async connect(connection: EntityProviderConnection): Promise<void> {
    this.#connection = connection;
  }

  getConnection() {
    if (!this.#connection) {
      throw new Error('Provider is not connected yet');
    }
    return this.#connection;
  }
}

class ProxyProgressTracker implements ProgressTracker {
  #inner: ProgressTracker;

  constructor(inner: ProgressTracker) {
    this.#inner = inner;
  }

  processStart(item: RefreshStateItem) {
    return this.#inner.processStart(item, voidLogger);
  }

  setTracker(tracker: ProgressTracker) {
    this.#inner = tracker;
  }
}

class NoopProgressTracker implements ProgressTracker {
  static emptyTracking = {
    markFailed() {},
    markProcessorsCompleted() {},
    markSuccessfulWithChanges() {},
    markSuccessfulWithErrors() {},
    markSuccessfulWithNoChanges() {},
  };

  processStart() {
    return NoopProgressTracker.emptyTracking;
  }
}

class WaitingProgressTracker implements ProgressTracker {
  #resolve: (errors: Record<string, Error>) => void;
  #promise: Promise<Record<string, Error>>;
  #counts = new Map<string, number>();
  #errors = new Map<string, Error>();
  #inFlight = new Array<Promise<void>>();

  constructor(private readonly entityRefs?: Set<string>) {
    let resolve: (errors: Record<string, Error>) => void;
    this.#promise = new Promise<Record<string, Error>>(_resolve => {
      resolve = _resolve;
    });
    this.#resolve = resolve!;
  }

  processStart(item: RefreshStateItem) {
    if (this.entityRefs && !this.entityRefs.has(item.entityRef)) {
      return NoopProgressTracker.emptyTracking;
    }

    let resolve: () => void;
    this.#inFlight.push(
      new Promise<void>(_resolve => {
        resolve = _resolve;
      }),
    );

    const currentCount = this.#counts.get(item.id) ?? 0;
    this.#counts.set(item.id, currentCount);

    const onDone = () => {
      this.#counts.set(item.id, currentCount + 1);

      if (Array.from(this.#counts.values()).every(c => c >= 2)) {
        this.#resolve(Object.fromEntries(this.#errors));
      }
    };
    return {
      markFailed: (error: Error) => {
        this.#errors.set(item.entityRef, error);
        onDone();
        resolve();
      },
      markProcessorsCompleted() {},
      markSuccessfulWithChanges: () => {
        this.#errors.delete(item.entityRef);
        this.#counts.set(item.id, 0);
        resolve();
      },
      markSuccessfulWithErrors: () => {
        this.#errors.delete(item.entityRef);
        onDone();
        resolve();
      },
      markSuccessfulWithNoChanges: () => {
        onDone();
        resolve();
      },
    };
  }

  async wait(): Promise<Record<string, Error>> {
    return this.#promise;
  }

  async waitForFinish(): Promise<void> {
    await Promise.all(this.#inFlight.slice());
  }
}

class TestHarness {
  readonly #catalog: EntitiesCatalog;
  readonly #engine: CatalogProcessingEngine;
  readonly #refresh: RefreshService;
  readonly #provider: TestProvider;
  readonly #proxyProgressTracker: ProxyProgressTracker;

  static async create(options?: {
    config?: JsonObject;
    logger?: Logger;
    db?: Knex;
    permissions?: PermissionEvaluator;
    processEntity?(
      entity: Entity,
      location: LocationSpec,
      emit: CatalogProcessorEmit,
    ): Promise<Entity>;
    onProcessingError?(event: {
      unprocessedEntity: Entity;
      errors: Error[];
    }): void;
  }) {
    const config = new ConfigReader(
      options?.config ?? {
        backend: {
          database: {
            client: 'better-sqlite3',
            connection: ':memory:',
          },
        },
      },
    );
    const logger = options?.logger ?? getVoidLogger();
    const db =
      options?.db ??
      (await DatabaseManager.fromConfig(config, { logger })
        .forPlugin('catalog')
        .getClient());

    await applyDatabaseMigrations(db);

    const processingDatabase = new DefaultProcessingDatabase({
      database: db,
      logger,
      refreshInterval: () => 0.05,
    });

    const integrations = ScmIntegrations.fromConfig(config);
    const rulesEnforcer = DefaultCatalogRulesEnforcer.fromConfig(config);
    const orchestrator = new DefaultCatalogProcessingOrchestrator({
      processors: [
        {
          getProcessorName: () => 'test',
          async validateEntityKind() {
            return true;
          },
          async preProcessEntity(
            entity: Entity,
            location: LocationSpec,
            emit: CatalogProcessorEmit,
          ) {
            if (options?.processEntity) {
              return options?.processEntity(entity, location, emit);
            }
            return entity;
          },
        },
      ],
      integrations,
      rulesEnforcer,
      logger,
      parser: defaultEntityDataParser,
      policy: EntityPolicies.allOf([]),
      legacySingleProcessorValidation: false,
    });
    const stitcher = new Stitcher(db, logger);
    const catalog = new DefaultEntitiesCatalog(db, stitcher);
    const proxyProgressTracker = new ProxyProgressTracker(
      new NoopProgressTracker(),
    );

    const engine = new DefaultCatalogProcessingEngine(
      logger,
      processingDatabase,
      orchestrator,
      stitcher,
      () => createHash('sha1'),
      50,
      event => {
        if (options?.onProcessingError) {
          options.onProcessingError(event);
        } else {
          throw new Error(
            `Catalog processing error, ${event.errors.join(', ')}`,
          );
        }
      },
      proxyProgressTracker,
    );

    const refresh = new DefaultRefreshService({ database: processingDatabase });

    const provider = new TestProvider();

    await connectEntityProviders(processingDatabase, [provider]);

    return new TestHarness(
      catalog,
      engine,
      refresh,
      provider,
      proxyProgressTracker,
    );
  }

  constructor(
    catalog: EntitiesCatalog,
    engine: CatalogProcessingEngine,
    refresh: RefreshService,
    provider: TestProvider,
    proxyProgressTracker: ProxyProgressTracker,
  ) {
    this.#catalog = catalog;
    this.#engine = engine;
    this.#refresh = refresh;
    this.#provider = provider;
    this.#proxyProgressTracker = proxyProgressTracker;
  }

  async process(entityRefs?: Set<string>) {
    const tracker = new WaitingProgressTracker(entityRefs);
    this.#proxyProgressTracker.setTracker(tracker);

    this.#engine.start();

    const errors = await tracker.wait();

    this.#engine.stop();
    await tracker.waitForFinish();

    this.#proxyProgressTracker.setTracker(new NoopProgressTracker());

    return errors;
  }

  async setInputEntities(entities: (Entity & { locationKey?: string })[]) {
    return this.#provider.getConnection().applyMutation({
      type: 'full',
      entities: entities.map(({ locationKey, ...entity }) => ({
        entity,
        locationKey,
      })),
    });
  }

  async getOutputEntities(): Promise<Record<string, Entity>> {
    const { entities } = await this.#catalog.entities();
    return Object.fromEntries(entities.map(e => [stringifyEntityRef(e), e]));
  }

  async refresh(options: RefreshOptions) {
    return this.#refresh.refresh(options);
  }
}

describe('Catalog Backend Integration', () => {
  it('should add entities and update errors', async () => {
    let triggerError = false;

    const harness = await TestHarness.create({
      async processEntity(entity: Entity) {
        if (triggerError) {
          throw new Error('NOPE');
        }
        return entity;
      },
    });

    await harness.setInputEntities([
      {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Component',
        metadata: {
          name: 'test',
          annotations: {
            'backstage.io/managed-by-location': 'url:.',
            'backstage.io/managed-by-origin-location': 'url:.',
          },
        },
      },
    ]);

    await expect(harness.getOutputEntities()).resolves.toEqual({});
    await expect(harness.process()).resolves.toEqual({});

    await expect(harness.getOutputEntities()).resolves.toEqual({
      'component:default/test': {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Component',
        metadata: expect.objectContaining({ name: 'test' }),
        relations: [],
      },
    });

    triggerError = true;

    await expect(harness.process()).resolves.toEqual({});

    await expect(harness.getOutputEntities()).resolves.toEqual({
      'component:default/test': {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Component',
        metadata: expect.objectContaining({ name: 'test' }),
        relations: [],
        status: {
          items: [
            {
              level: 'error',
              type: 'backstage.io/catalog-processing',
              message:
                'InputError: Processor Object threw an error while preprocessing; caused by Error: NOPE',
              error: {
                name: 'InputError',
                message:
                  'Processor Object threw an error while preprocessing; caused by Error: NOPE',
                cause: {
                  name: 'Error',
                  message: 'NOPE',
                  stack: expect.stringMatching(/^Error: NOPE/),
                },
              },
            },
          ],
        },
      },
    });
  });

  it('should orphan entities', async () => {
    const generatedApis = ['api-1', 'api-2'];

    const harness = await TestHarness.create({
      async processEntity(
        entity: Entity,
        location: LocationSpec,
        emit: CatalogProcessorEmit,
      ) {
        if (entity.metadata.name === 'test') {
          for (const api of generatedApis) {
            emit(
              processingResult.entity(location, {
                apiVersion: 'backstage.io/v1alpha1',
                kind: 'API',
                metadata: {
                  name: api,
                  annotations: {
                    'backstage.io/managed-by-location': 'url:.',
                    'backstage.io/managed-by-origin-location': 'url:.',
                  },
                },
              }),
            );
          }
        }
        return entity;
      },
    });

    await harness.setInputEntities([
      {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Component',
        metadata: {
          name: 'test',
          annotations: {
            'backstage.io/managed-by-location': 'url:.',
            'backstage.io/managed-by-origin-location': 'url:.',
          },
        },
      },
    ]);

    await expect(harness.getOutputEntities()).resolves.toEqual({});
    await expect(harness.process()).resolves.toEqual({});

    await expect(harness.getOutputEntities()).resolves.toEqual({
      'component:default/test': {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Component',
        metadata: expect.objectContaining({ name: 'test' }),
        relations: [],
      },
      'api:default/api-1': expect.objectContaining({
        metadata: expect.objectContaining({ name: 'api-1' }),
      }),
      'api:default/api-2': expect.objectContaining({
        metadata: expect.objectContaining({ name: 'api-2' }),
      }),
    });

    generatedApis.pop();

    await expect(harness.process()).resolves.toEqual({});

    await expect(harness.getOutputEntities()).resolves.toEqual({
      'component:default/test': {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Component',
        metadata: expect.objectContaining({ name: 'test' }),
        relations: [],
      },
      'api:default/api-1': expect.objectContaining({
        metadata: expect.objectContaining({ name: 'api-1' }),
      }),
      'api:default/api-2': expect.objectContaining({
        metadata: expect.objectContaining({
          name: 'api-2',
          annotations: expect.objectContaining({
            'backstage.io/orphan': 'true',
          }),
        }),
      }),
    });
  });

  it('should not replace matching provided entities', async () => {
    const harness = await TestHarness.create();

    const entityA = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: {
        name: 'a',
        annotations: {
          'backstage.io/managed-by-location': 'url:.',
          'backstage.io/managed-by-origin-location': 'url:.',
        },
      },
    };
    const entityB = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: {
        name: 'b',
        annotations: {
          'backstage.io/managed-by-location': 'url:.',
          'backstage.io/managed-by-origin-location': 'url:.',
        },
      },
    };

    const entities = [entityA, { locationKey: 'loc', ...entityB }];

    await harness.setInputEntities(entities);
    await expect(harness.process()).resolves.toEqual({});

    const outputEntities = await harness.getOutputEntities();

    await expect(harness.getOutputEntities()).resolves.toEqual({
      'component:default/a': expect.anything(),
      'component:default/b': expect.anything(),
    });

    await harness.setInputEntities(entities);
    await expect(harness.process()).resolves.toEqual({});

    await expect(harness.getOutputEntities()).resolves.toEqual(outputEntities);
  });

  // NOTE(freben): This test documents existing behavior, but it would be more correct to mark the cycle as orphans
  it('leaves behind orphaned cycles without orphan markers', async () => {
    function mkEntity(name: string) {
      return {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Component',
        metadata: {
          name,
          annotations: {
            'backstage.io/managed-by-location': 'url:.',
            'backstage.io/managed-by-origin-location': 'url:.',
          },
        },
      };
    }

    const harness = await TestHarness.create({
      async processEntity(
        entity: Entity,
        location: LocationSpec,
        emit: CatalogProcessorEmit,
      ) {
        if (entity.spec?.noEmit) {
          return entity;
        }
        switch (entity.metadata.name) {
          case 'a':
            emit(processingResult.entity(location, mkEntity('b')));
            break;
          case 'b':
            emit(processingResult.entity(location, mkEntity('c')));
            break;
          case 'c':
            emit(processingResult.entity(location, mkEntity('d')));
            break;
          case 'd':
            emit(processingResult.entity(location, mkEntity('b')));
            break;
          default:
        }
        return entity;
      },
    });

    await harness.setInputEntities([
      {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Component',
        metadata: {
          name: 'a',
          annotations: {
            'backstage.io/managed-by-location': 'url:.',
            'backstage.io/managed-by-origin-location': 'url:.',
          },
        },
      },
    ]);

    await expect(harness.getOutputEntities()).resolves.toEqual({});
    await expect(harness.process()).resolves.toEqual({});

    await expect(harness.getOutputEntities()).resolves.toEqual({
      'component:default/a': expect.objectContaining({
        metadata: expect.objectContaining({ name: 'a' }),
      }),
      'component:default/b': expect.objectContaining({
        metadata: expect.objectContaining({ name: 'b' }),
      }),
      'component:default/c': expect.objectContaining({
        metadata: expect.objectContaining({ name: 'c' }),
      }),
      'component:default/d': expect.objectContaining({
        metadata: expect.objectContaining({ name: 'd' }),
      }),
    });
    // NOTE(freben): Avoid .toHaveProperty here, since it treats dots as path separators
    expect(
      (await harness.getOutputEntities())['component:default/b'].metadata
        .annotations!['backstage.io/orphan'],
    ).toBeUndefined();
    expect(
      (await harness.getOutputEntities())['component:default/c'].metadata
        .annotations!['backstage.io/orphan'],
    ).toBeUndefined();
    expect(
      (await harness.getOutputEntities())['component:default/d'].metadata
        .annotations!['backstage.io/orphan'],
    ).toBeUndefined();

    await harness.setInputEntities([
      {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Component',
        metadata: {
          name: 'a',
          annotations: {
            'backstage.io/managed-by-location': 'url:.',
            'backstage.io/managed-by-origin-location': 'url:.',
          },
        },
        spec: { noEmit: true },
      },
    ]);

    await expect(harness.process()).resolves.toEqual({});

    await expect(harness.getOutputEntities()).resolves.toEqual({
      'component:default/a': expect.objectContaining({
        metadata: expect.objectContaining({ name: 'a' }),
      }),
      'component:default/b': expect.objectContaining({
        metadata: expect.objectContaining({ name: 'b' }),
      }),
      'component:default/c': expect.objectContaining({
        metadata: expect.objectContaining({ name: 'c' }),
      }),
      'component:default/d': expect.objectContaining({
        metadata: expect.objectContaining({ name: 'd' }),
      }),
    });
    // TODO(freben): Ideally these should be orphaned now
    expect(
      (await harness.getOutputEntities())['component:default/b'].metadata
        .annotations!['backstage.io/orphan'],
    ).toBeUndefined();
    expect(
      (await harness.getOutputEntities())['component:default/c'].metadata
        .annotations!['backstage.io/orphan'],
    ).toBeUndefined();
    expect(
      (await harness.getOutputEntities())['component:default/d'].metadata
        .annotations!['backstage.io/orphan'],
    ).toBeUndefined();
  });
});
