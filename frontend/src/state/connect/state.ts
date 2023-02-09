/**
 * Copyright 2022 Redpanda Data, Inc.
 *
 * Use of this software is governed by the Business Source License
 * included in the file https://github.com/redpanda-data/redpanda/blob/dev/licenses/bsl.md
 *
 * As of the Change Date specified in that file, in accordance with
 * the Business Source License, use of this software will be governed
 * by the Apache License, Version 2.0
 */

/* eslint-disable no-useless-escape */
import { action, comparer, IReactionDisposer, observable, reaction, intercept, makeAutoObservable, flow, autorun } from 'mobx';
import { api } from '../backendApi';
import {
    ConnectorProperty,
    DataType,
    PropertyImportance,
    PropertyWidth,
    ClusterConnectors,
    ConnectorPossibleStatesLiteral,
} from '../restInterfaces';
import { removeNamespace } from '../../components/pages/connect/helper';
import { encodeBase64, retrier } from '../../utils/utils';

export interface ConfigPageProps {
    clusterName: string;
    pluginClassName: string;
    onChange: (jsonText: string, secrets?: ConnectorSecret) => void;
}

export type ConnectorSecret = Map<string, string>;
export type UpdatingConnectorData = { clusterName: string; connectorName: string };
export type RestartingTaskData = { clusterName: string; connectorName: string; taskId: number };

class CustomError extends Error {
    constructor(message: any) {
        super(message);
        this.name = this.constructor.name;
    }
}
export class ConnectorValidationError extends CustomError { }

export class ConnectorCreationError extends CustomError { }

export class SecretCreationError extends CustomError { }

export class ConnectorsStore { }

export class ConnectClusterStore {
    private clusterName: string;
    isInitialized: boolean = false;
    private connectors: Map<string, ConnectorPropertiesStore>;
    features: ConnectorClusterFeatures = { secretStore: false };

    static connectClusters: Map<string, ConnectClusterStore> = new Map();
    constructor(clusterName: string) {
        this.clusterName = clusterName;
        makeAutoObservable<ConnectClusterStore, 'plugins' | 'connectors'>(this, {
            setup: action.bound,
            createConnector: flow.bound,
            deleteConnector: flow.bound,
            updateConnnector: flow.bound,
            plugins: observable,
            connectors: observable,
        });
    }

    static getInstance(clusterName: string): ConnectClusterStore {
        let instance = ConnectClusterStore.connectClusters.get(clusterName);
        if (!instance) {
            instance = new ConnectClusterStore(clusterName);
            this.connectClusters.set(clusterName, instance);
        }
        return instance;
    }

    async setup() {
        if (!this.isInitialized) {
            this.connectors = new Map();
            await this.refreshData(false);

            const additionalClusterInfo = api.connectAdditionalClusterInfo.get(this.clusterName);
            this.features.secretStore = !!additionalClusterInfo?.enabledFeatures?.some((x) => x === 'SECRET_STORE');
            this.isInitialized = true;
        }
    }

    async refreshData(force: boolean) {
        await api.refreshConnectClusters(force);
        await api.refreshClusterAdditionalInfo(this.clusterName, force);
    }

    // CRUD operations
    createConnector = flow(function*(this: ConnectClusterStore, pluginClass: string) {
        const connector = this.getConnector(pluginClass);
        const secrets = connector.secrets;
        if (secrets) {
            try {
                for (const [key, secret] of secrets.secrets) {
                    const connectorName = connector.propsByName.get('name');
                    if (!connectorName) throw new Error('For some reason your connector doesn\'t have a name');
                    const createSecretResponse = yield api.createSecret(this.clusterName, connectorName.value as string, secret.serialized);
                    const property = connector.propsByName.get(key);
                    if (property) property.value = secret.getSecretString(key, createSecretResponse?.secretId);
                }
            } catch (error) {
                throw new SecretCreationError(error);
            }
        }
        try {
            const finalProperties: Record<string, any> = connector.getConfigObject();
            yield api.createConnector(this.clusterName, finalProperties.name, pluginClass, finalProperties);
            this.removePluginState(pluginClass);
        } catch (error) {
            // In case we want to delete secrets on failure
            // if (secrets) {
            //     yield Promise.all(
            //         secrets.ids.map((secretId) =>
            //             retrier(() => api.deleteSecret(this.clusterName, secretId), { attempts: 3, delayTime: 200 })
            //         )
            //     );
            // }
            throw new ConnectorCreationError(error);
        }
    });

    deleteConnector = flow(function*(this: ConnectClusterStore, connectorName: string) {
        const connectorState = this.getConnectorStore(connectorName);
        const secrets = connectorState.secrets;

        yield api.deleteConnector(this.clusterName, connectorName);

        if (secrets) {
            yield Promise.all(
                secrets.ids.map((secretId) => retrier(() => api.deleteSecret(this.clusterName, secretId), { attempts: 3, delayTime: 200 }))
            );
        }
    });

    updateConnnector = flow(function*(this: ConnectClusterStore, connectorName: string) {
        const remoteConnector = this.getRemoteConnector(connectorName);

        const connectorState = this.getConnectorStore(connectorName);
        const newConfigObj = connectorState?.getConfigObject();
        if (newConfigObj) {
            const secrets = connectorState?.secrets;
            if (secrets) {
                for (const [key, secret] of secrets.secrets) {
                    if (secret.isDirty && secret.id) {
                        const createSecretResponse = yield api.updateSecret(this.clusterName, secret.id, secret.serialized);
                        const property = connectorState.propsByName.get(key);
                        if (property) property.value = secret.getSecretString(key, createSecretResponse?.secretId);
                    }
                }
            }
            if (remoteConnector) yield api.updateConnector(this.clusterName, connectorName, connectorState.getConfigObject());
        }
    });

    removePluginState(identifier: string) {
        this.connectors.delete(identifier);
    }

    getConnector(pluginClassName: string, connectorName: string | null = null, initialConfig: Record<string, any> | undefined = undefined) {
        const identifier = connectorName ? `${pluginClassName}/${connectorName}` : pluginClassName;
        let connectorStore = this.connectors.get(identifier);
        if (!connectorStore) {
            connectorStore = new ConnectorPropertiesStore(this.clusterName, pluginClassName, initialConfig, {
                secretStore: this.features.secretStore,
            });

            this.connectors.set(identifier, connectorStore);
        }
        return connectorStore;
    }

    getConnectorStore(connectorName: string) {
        const connector = this.getRemoteConnector(connectorName);
        const connectorProperties = this.getConnector(connector!.class, connectorName, connector?.config);
        return connectorProperties;
    }

    get cluster(): ClusterConnectors | null {
        if (this.isInitialized) {
            const cluster = api.connectConnectors?.clusters?.first((c) => c.clusterName == this.clusterName);
            if (!cluster) throw new Error('cluster not found');
            return cluster;
        }
        return null;
    }

    get canEdit() {
        if (this.isInitialized) {
            return this.cluster?.canEditCluster;
        }
        return null;
    }

    validateConnectorState(connectorName: string, state: ConnectorPossibleStatesLiteral[]) {
        if (this.isInitialized) {
            const cluster = this.cluster;
            const connector = cluster?.connectors.first((c) => c.name == connectorName);
            return state.some((s) => s === connector?.state);
        }
        throw new Error('The ConnectorClusterStore is not initialized');
    }

    getConnectorState(connectorName: string) {
        if (this.isInitialized) {
            const connector = this.getRemoteConnector(connectorName);
            return connector?.state;
        }
        return null;
    }

    getConnectorTasks(connectorName: string) {
        if (this.isInitialized) {
            const connector = this.getRemoteConnector(connectorName);
            return connector?.tasks;
        }
    }

    getRemoteConnector(connectorName: string) {
        if (this.isInitialized) {
            const cluster = this.cluster;
            const connector = cluster?.connectors.first((c) => c.name == connectorName);
            if (!connector) throw new Error('connector not found');
            return connector;
        }
    }
}

export interface ConnectorClusterFeatures {
    secretStore?: boolean;
}

export class SecretsStore {
    secrets = new Map<string, Secret>();

    constructor() {
        makeAutoObservable(this);
    }

    getSecret(key: string) {
        let secret = this.secrets.get(key);

        if (!secret) {
            secret = new Secret(key);
            this.secrets.set(key, secret);
        }
        return secret;
    }

    get ids(): string[] {
        return Array.from(this.secrets, ([_key, secret]) => secret.id).filter((secret): secret is string => Boolean(secret));
    }
}

export class Secret {
    key: string;
    value: string;
    id: string | null = null;
    secretString: string | null = null;
    isDirty: boolean = false;

    constructor(key: string) {
        this.key = key;
        makeAutoObservable(this);
        autorun(() => {
            if (this.secretString && this.value) {
                this.isDirty = this.value !== this.secretString;
            }
        });
    }

    get serialized() {
        return encodeBase64(JSON.stringify({ [this.key]: this.value }));
    }

    get toJS() {
        return {
            [this.key]: this.value,
        };
    }

    getSecretString(key: string, id?: string): string | null {
        const _id = id ?? this.id;
        if (_id) return `\${secretsManager:${_id}:${key}}`;
        return null;
    }

    extractSecretId(secretString: string): boolean {
        if (!this.validateSecretString(secretString)) return false;
        this.id = String(secretString).split(':')[1];
        return !!this.id;
    }

    validateSecretString(secretString: string): boolean {
        const regex = /^\$\{secretsManager:[A-Za-z\-0-9]+:.+\}$/;
        const validationResult = regex.test(secretString);
        if (validationResult) this.secretString = secretString;
        return validationResult;
    }
}

export class ConnectorPropertiesStore {
    allGroups: PropertyGroup[] = [];
    propsByName = observable.map<string, Property>();
    jsonText = '';
    error: string | undefined = undefined;
    secrets: SecretsStore | null = null;
    advancedMode = 'simple' as 'simple' | 'advanced';
    initPending = true;
    fallbackGroupName: string = '';
    reactionDisposers: IReactionDisposer[] = [];

    constructor(
        private clusterName: string,
        private pluginClassName: string,
        private appliedConfig: Record<string, any> | undefined,
        features?: ConnectorClusterFeatures
    ) {
        makeAutoObservable(this, {
            fallbackGroupName: false,
            reactionDisposers: false,
            initConfig: action.bound,
        });
        if (features?.secretStore) this.secrets = new SecretsStore();
        this.fallbackGroupName = removeNamespace(this.pluginClassName);
        this.initConfig();
    }

    createPropertyGroup(groupName: string, properties: Property[]) {
        const self = this;

        return observable<PropertyGroup>({
            groupName,
            properties,
            propertiesWithErrors: [],

            get filteredProperties(): Property[] {
                if (self.advancedMode == 'advanced')
                    // advanced mode shows all settings
                    return this.properties;

                // in simple mode, we only show props that are high importance
                return this.properties.filter((p) => p.entry.definition.importance == PropertyImportance.High);
            },
        });
    }
    getConfigObject(): object {
        const config = {} as any;

        for (const g of this.allGroups)
            for (const p of g.properties) {
                // Skip default values
                if (p.entry.definition.required == false) {
                    if (p.value == p.entry.definition.default_value) continue;
                    if (p.value === false && !p.entry.definition.default_value) continue; // skip boolean values that default to false
                }

                // Skip null/undefined
                if (p.value === null || p.value === undefined) continue;

                // Skip empty values for strings
                if (StringLikeTypes.includes(p.entry.definition.type)) if (p.value == null || p.value == '') continue;

                // Include the value
                config[p.name] = p.value;
            }
        return config;
    }

    updateProperties(properties: Record<string, any>) {
        for (const [key, value] of Object.entries(properties)) {
            const property = this.propsByName.get(key);
            if (property) property.value = value;
        }
    }

    updatePropertiesFromString(input: string) {
        const _input = JSON.parse(input);
        return this.updateProperties(_input);
    }

    async initConfig() {
        const { clusterName, pluginClassName } = this;

        try {
            // Validate with empty object to get all properties initially
            const validationResult = await api.validateConnectorConfig(clusterName, pluginClassName, {
                'connector.class': pluginClassName,
                name: '',
                topic: 'topic',
                topics: 'topics',
            });
            const allProps = this.createCustomProperties(validationResult.configs, this.appliedConfig);

            // Save props to map, so we can quickly find them to set their validation errors
            for (const p of allProps) this.propsByName.set(p.name, p);

            // Set default values
            for (const p of allProps)
                if (p.entry.definition.custom_default_value != undefined) {
                    p.value = p.entry.definition.custom_default_value;
                }

            // Set last error values, so we know when to show the validation error
            for (const p of allProps) if (p.errors.length > 0) p.lastErrorValue = p.value;

            // Create groups
            const groupNames = [this.fallbackGroupName, ...validationResult.groups];
            this.allGroups = allProps
                .groupInto((p) => p.entry.definition.group)
                .map((g) => this.createPropertyGroup(g.key ?? '', g.items))
                .sort((a, b) => groupNames.indexOf(a.groupName) - groupNames.indexOf(b.groupName));

            // Let properties know about their parent group, so they can add/remove themselves in 'propertiesWithErrors'
            for (const g of this.allGroups) for (const p of g.properties) p.propertyGroup = g;

            // Notify groups about errors in their children
            for (const g of this.allGroups) g.propertiesWithErrors.push(...g.properties.filter((p) => p.showErrors));

            // Update JSON
            this.reactionDisposers.push(
                reaction(
                    () => {
                        return this.getConfigObject();
                    },
                    (config) => {
                        this.jsonText = JSON.stringify(config, undefined, 4);
                    },
                    { delay: 100, fireImmediately: true, equals: comparer.structural }
                )
            );

            // Validate on changes
            this.reactionDisposers.push(
                reaction(
                    () => {
                        return this.getConfigObject();
                    },
                    (config) => {
                        this.validate(config);
                    },
                    { delay: 300, fireImmediately: true, equals: comparer.structural }
                )
            );
        } catch (err: any) {
            this.error = typeof err == 'object' ? err.message ?? JSON.stringify(err, undefined, 4) : JSON.stringify(err, undefined, 4);
        }

        this.initPending = false;
    }

    async validate(config: object) {
        const { clusterName, pluginClassName } = this;
        try {
            // Validate the current config
            const validationResult = await api.validateConnectorConfig(clusterName, pluginClassName, config);
            const srcProps = this.createCustomProperties(validationResult.configs);

            // Remove properties that don't exist anymore
            const srcNames = new Set(srcProps.map((x) => x.name));
            const removedProps = [...this.propsByName.keys()].filter((key) => !srcNames.has(key));
            for (const key of removedProps) {
                // group names might not be accurate so we check all groups
                for (const g of this.allGroups) g.properties.removeAll((x) => x.name == key);

                // remove from lookup
                this.propsByName.delete(key);
            }

            // Remove empty groups
            this.allGroups.removeAll((x) => x.properties.length == 0);

            // Handle new properties, transfer reported errors and suggested values
            for (const source of srcProps) {
                const target = this.propsByName.get(source.name);

                // Property does not exist yet, create it!
                if (!target) {
                    this.propsByName.set(source.name, source);

                    // Find existing group it belongs to, or create a new one for it
                    let group = this.allGroups.first((g) => g.groupName == source.entry.definition.group);
                    if (!group) {
                        // Create new group
                        group = this.createPropertyGroup(source.entry.definition.group!, []);
                        this.allGroups.push(group);

                        // Sort groups
                        const groupNames = [this.fallbackGroupName, ...validationResult.groups];
                        this.allGroups.sort((a, b) => groupNames.indexOf(a.groupName) - groupNames.indexOf(b.groupName));
                    }

                    // Add the property to the group
                    group.properties.push(source);
                    source.propertyGroup = group;

                    // Sort properties within group
                    group.properties.sort((a, b) => a.entry.definition.order - b.entry.definition.order);

                    continue;
                }

                // Update: recommended values
                const suggestedSrc = source.entry.value.recommended_values;
                const suggestedTar = target.entry.value.recommended_values;
                if (!suggestedSrc.isEqual(suggestedTar)) suggestedTar.updateWith(suggestedSrc);

                // Update: errors
                if (!target.errors.isEqual(source.errors)) {
                    if (source.errors.length > 0) target.lastErrors = [...source.errors]; // create copy, so 'updateWith' won't modify this array as well

                    // Update
                    target.errors.updateWith(source.errors);

                    target.showErrors = target.errors.length > 0;

                    // Show first error
                    target.currentErrorIndex = 0;
                    if (target.errors.length > 1) {
                        // Skip over simple / unhelpful messages
                        const betterStartValue = target.errors.findIndex((x) => !x.includes('which has no default value'));
                        if (betterStartValue > -1) target.currentErrorIndex = betterStartValue;
                    }

                    // Add or remove from parent group
                    const hasErrors = target.errors.length > 0;
                    if (hasErrors) target.propertyGroup.propertiesWithErrors.pushDistinct(target);
                    else target.propertyGroup.propertiesWithErrors.remove(target);
                }
            }

            // Set last error values, so we know when to show the validation error
            for (const g of this.allGroups) for (const p of g.properties) p.lastErrorValue = p.value;
        } catch (err: any) {
            console.error('error validating config', err);
        }
    }

    // Creates our Property objects, while fixing some issues with the source data
    // like: missing value, propertyWidth, group, ...
    createCustomProperties(properties: ConnectorProperty[], values: Record<string, any> = {}): Property[] {
        // Fix missing properties
        for (const p of properties) {
            const def = p.definition;

            if (!def.width || def.width == PropertyWidth.None) def.width = PropertyWidth.Medium;

            if (!def.group) def.group = this.fallbackGroupName;

            if (def.order < 0) def.order = Number.POSITIVE_INFINITY;
        }

        // Create our own properties
        const allProps = properties
            .map((p) => {
                const name = p.definition.name;

                // Fix type of default values
                let defaultValue: any = p.definition.default_value;
                let initialValue: any = p.value.value;
                if (p.definition.type == DataType.Boolean) {
                    // Boolean
                    // convert 'false' | 'true' to actual boolean values
                    if (typeof defaultValue == 'string')
                        if (defaultValue.toLowerCase() == 'false') defaultValue = p.definition.default_value = false as any;
                        else if (defaultValue.toLowerCase() == 'true') defaultValue = p.definition.default_value = true as any;

                    if (typeof initialValue == 'string')
                        if (initialValue.toLowerCase() == 'false') initialValue = p.value.value = false as any;
                        else if (initialValue.toLowerCase() == 'true') initialValue = p.value.value = true as any;
                }
                if (p.definition.type == DataType.Int || p.definition.type == DataType.Long || p.definition.type == DataType.Short) {
                    // Number
                    const n = Number.parseFloat(defaultValue);
                    if (Number.isFinite(n)) defaultValue = p.definition.default_value = n as any;
                }

                let value: any = initialValue ?? defaultValue;
                if (p.definition.type == DataType.Boolean && value == null) value = false; // use 'false' as default for boolean

                const property = observable({
                    name: name,
                    entry: p,
                    value: value,
                    isHidden: hiddenProperties.includes(name),
                    suggestedValues: suggestedValues[name],
                    errors: p.value.errors ?? [],
                    isSensitive: p.definition.type === DataType.Password && !!this.secrets,
                    lastErrors: [],
                    showErrors: p.value.errors.length > 0,
                    currentErrorIndex: 0,
                    lastErrorValue: undefined as any,
                    propertyGroup: undefined as any,
                });

                if (property.isSensitive && !!this.secrets) {
                    const secret = this.secrets.getSecret(property.name);
                    intercept(property, 'value', (change) => {
                        secret.extractSecretId(change.newValue);
                        secret.value = change.newValue;
                        return change;
                    });
                }

                if (values[name]) property.value = values[name];

                return property;
            })
            .sort((a, b) => a.entry.definition.order - b.entry.definition.order);

        return allProps;
    }
}

const hiddenProperties = [
    'connector.class', // user choses that in the first page of the wizard
];

const converters = [
    'io.confluent.connect.avro.AvroConverter',
    'io.confluent.connect.protobuf.ProtobufConverter',
    'org.apache.kafka.connect.storage.StringConverter',
    'org.apache.kafka.connect.json.JsonConverter',
    'io.confluent.connect.json.JsonSchemaConverter',
    'org.apache.kafka.connect.converters.ByteArrayConverter',
];
const suggestedValues: { [key: string]: string[] } = {
    'key.converter': converters,
    'value.converter': converters,
    'header.converter': converters,
    'config.action.reload': ['restart', 'none'],
};

export interface PropertyGroup {
    groupName: string;
    properties: Property[];

    readonly filteredProperties: Property[];

    propertiesWithErrors: Property[];
}

export interface Property {
    name: string;
    entry: ConnectorProperty;
    value: null | string | number | boolean | string[];

    isHidden: boolean; // currently only used for "connector.class"
    suggestedValues: undefined | string[]; // values that are not listed in entry.value.recommended_values
    errors: string[]; // current errors
    isSensitive: boolean | undefined;
    showErrors: boolean; // true = property has errors currently
    lastErrors: string[]; // previous errors, used so we can fade/animate them out when they get fixed
    currentErrorIndex: number; // since we can only display one error at a time, we use this to cycle through
    lastErrorValue: any; // the 'value' the property had at the last validation check (used so we can immediately hide the reported error once the user changes the value)

    propertyGroup: PropertyGroup;
}

const StringLikeTypes = [DataType.String, DataType.Class, DataType.List, DataType.Password];
