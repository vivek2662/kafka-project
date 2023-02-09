
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

/*eslint block-scoped-var: "error"*/

import { notification } from 'antd';
import { comparer, computed, observable, transaction } from 'mobx';
import { AppFeatures } from '../utils/env';
import fetchWithTimeout from '../utils/fetchWithTimeout';
import { toJson } from '../utils/jsonUtils';
import { LazyMap } from '../utils/LazyMap';
import { ObjToKv } from '../utils/tsxUtils';
import { decodeBase64, TimeSince } from '../utils/utils';
import { appGlobal } from './appGlobal';
import {
    GetAclsRequest, AclRequestDefault, GetAclOverviewResponse, AdminInfo,
    AlterConfigOperation, AlterPartitionReassignmentsResponse, ApiError,
    Broker, BrokerConfigResponse, ClusterAdditionalInfo, ClusterConnectors,
    ClusterInfo, ClusterInfoResponse, ConfigEntry, ConfigResourceType,
    ConnectorValidationResult, CreateTopicRequest, CreateTopicResponse,
    DeleteConsumerGroupOffsetsRequest, DeleteConsumerGroupOffsetsResponse,
    DeleteConsumerGroupOffsetsResponseTopic, DeleteConsumerGroupOffsetsTopic,
    DeleteRecordsResponseData, EditConsumerGroupOffsetsRequest,
    EditConsumerGroupOffsetsResponse, EditConsumerGroupOffsetsResponseTopic,
    EditConsumerGroupOffsetsTopic, EndpointCompatibility,
    EndpointCompatibilityResponse, GetAllPartitionsResponse,
    GetConsumerGroupResponse, GetConsumerGroupsResponse, GetPartitionsResponse,
    GetTopicConsumersResponse, GetTopicOffsetsByTimestampResponse,
    GetTopicsResponse, GroupDescription, isApiError, KafkaConnectors,
    PartialTopicConfigsResponse, Partition, PartitionReassignmentRequest,
    PartitionReassignments, PartitionReassignmentsResponse,
    PatchConfigsRequest, PatchConfigsResponse, ProduceRecordsResponse,
    PublishRecordsRequest, QuotaResponse, ResourceConfig, SchemaDetails,
    SchemaDetailsResponse, SchemaOverview, SchemaOverviewResponse, SchemaType,
    Topic, TopicConfigResponse, TopicConsumer, TopicDescription,
    TopicDocumentation, TopicDocumentationResponse, TopicMessage, TopicOffset,
    TopicPermissions, UserData, WrappedApiError, CreateACLRequest,
    DeleteACLsRequest, RedpandaLicense, AclResource, GetUsersResponse, CreateUserRequest, PatchTopicConfigsRequest
} from './restInterfaces';
import { uiState } from './uiState';
import { config as appConfig } from '../config';

const REST_TIMEOUT_SEC = 25;
export const REST_CACHE_DURATION_SEC = 20;

/*
    - If statusCode is not 2xx (any sort of error) -> response content will always be an `ApiError` json object
    - 2xx does not mean complete success, for some endpoints (e.g.: broker log dirs) we can get partial responses (array with some result entries and some error entries)
*/

/*
* allow custom fetch or websocket interceptors
* */
export async function rest<T>(url: string, requestInit?: RequestInit): Promise<T | null> {
    const res = await fetchWithTimeout(url, REST_TIMEOUT_SEC * 1000, requestInit);

    if (res.status == 401) { // Unauthorized
        await handle401(res);
        return null;
    }
    if (res.status == 403) { // Forbidden
        return null;
    }

    const text = await res.text();

    processVersionInfo(res.headers);

    return parseOrUnwrap<T>(res, text);
}

async function handle401(res: Response) {
    // Logout
    //   Clear our 'User' data if we have any
    //   Any old/invalid JWT will be cleared by the server
    api.userData = null;

    try {
        const text = await res.text();
        const obj = JSON.parse(text);
        console.log('unauthorized message: ' + text);

        const err = obj as ApiError;
        uiState.loginError = String(err.message);
    } catch (err) {
        uiState.loginError = String(err);
    }

    // Save current location url
    // store.urlBeforeLogin = window.location.href;

    // Redirect to login
    appGlobal.history.push('/login');
}

function processVersionInfo(headers: Headers) {
    try {
        for (const [k, v] of headers) {
            if (k.toLowerCase() != 'app-build-timestamp')
                continue;

            const serverBuildTimestamp = Number(v);
            if (v != null && v != '' && Number.isFinite(serverBuildTimestamp)) {
                if (uiState.serverBuildTimestamp != serverBuildTimestamp)
                    uiState.serverBuildTimestamp = serverBuildTimestamp;
            }

            return;
        }
    } catch { } // Catch malformed json (old versions where info is not sent as json yet)
}

const cache = new LazyMap<string, CacheEntry>(u => new CacheEntry(u));
class CacheEntry {
    url: string;

    private timeSinceLastResult = new TimeSince(); // set automatically
    /** How long ago (in seconds) the data was last updated */
    get resultAge() { return this.timeSinceLastResult.value / 1000; }

    private promise: Promise<any>;
    get lastPromise() { return this.promise; }
    setPromise<T>(promise: Promise<T>) {
        this.timeSinceRequestStarted.reset();

        this.isPending = true;
        this.error = null;
        this.promise = promise;

        promise.then(result => {
            this.timeSinceLastResult.reset();
            this.lastResult = result;
        }).catch(err => {
            this.lastResult = undefined;
            this.error = err;
        }).finally(() => {
            this.lastRequestDurationMs = this.timeSinceRequestStarted.value;
            const index = api.activeRequests.indexOf(this);
            if (index > -1) {
                api.activeRequests.splice(index, 1);
            }
            this.isPending = false;
        });

        api.activeRequests.push(this);
    }

    error: any | null = null;
    lastResult: any | undefined; // set automatically
    isPending: boolean; // set automatically

    private timeSinceRequestStarted = new TimeSince(); // set automatically
    private lastRequestDurationMs: number; // set automatically
    /** How long (in seconds) the last request took (or is currently taking so far) */
    get requestTime() {
        if (this.isPending) {
            return this.timeSinceRequestStarted.value / 1000;
        }
        return this.lastRequestDurationMs / 1000;
    }

    constructor(url: string) {
        this.url = url;
        const sec = 1000;
        const min = 60 * sec;
        const h = 60 * min;
        this.timeSinceLastResult.reset(100 * h);
    }
}

function cachedApiRequest<T>(url: string, force: boolean = false): Promise<T> {
    const entry = cache.get(url);

    if (entry.isPending) {
        // return already running request
        return entry.lastPromise;
    }

    if (entry.resultAge > REST_CACHE_DURATION_SEC || force) {
        // expired or force refresh
        const promise = rest<T>(url);
        entry.setPromise(promise);
    }

    // Return last result (can be still pending, or completed but not yet expired)
    return entry.lastPromise;
}


let currentWS: WebSocket | null = null;

//
// BackendAPI
//
const apiStore = {

    // Data
    endpointCompatibility: null as (EndpointCompatibility | null),
    licenses: null as (RedpandaLicense[] | null),

    clusters: ['A', 'B', 'C'],
    clusterInfo: null as (ClusterInfo | null),

    brokerConfigs: new Map<number, ConfigEntry[] | string>(), // config entries, or error string

    adminInfo: undefined as (AdminInfo | undefined | null),

    schemaOverview: undefined as (SchemaOverview | null | undefined), // undefined = request not yet complete; null = server responded with 'there is no data'
    schemaOverviewIsConfigured: undefined as boolean | undefined,
    schemaDetails: null as (SchemaDetails | null),

    topics: null as (Topic[] | null),
    topicConfig: new Map<string, TopicDescription | null>(), // null = not allowed to view config of this topic
    topicDocumentation: new Map<string, TopicDocumentation>(),
    topicPermissions: new Map<string, TopicPermissions | null>(),
    topicPartitions: new Map<string, Partition[] | null>(), // null = not allowed to view partitions of this config
    topicPartitionErrors: new Map<string, Array<{ id: number, partitionError: string; }>>(),
    topicWatermarksErrors: new Map<string, Array<{ id: number, waterMarksError: string; }>>(),
    topicConsumers: new Map<string, TopicConsumer[]>(),
    topicAcls: new Map<string, GetAclOverviewResponse | null>(),

    serviceAccounts: undefined as GetUsersResponse | undefined | null,
    ACLs: undefined as GetAclOverviewResponse | undefined | null,

    Quotas: undefined as QuotaResponse | undefined | null,

    consumerGroups: new Map<string, GroupDescription>(),
    consumerGroupAcls: new Map<string, GetAclOverviewResponse | null>(),

    partitionReassignments: undefined as (PartitionReassignments[] | null | undefined),

    connectConnectors: undefined as (KafkaConnectors | undefined),
    connectAdditionalClusterInfo: new Map<string, ClusterAdditionalInfo>(), // clusterName => additional info (plugins)

    // undefined = we haven't checked yet
    // null = call completed, and we're not logged in
    userData: undefined as (UserData | null | undefined),
    async logout() {
        await appConfig.fetch('./logout');
        this.userData = null;
    },

    // Make currently running requests observable
    activeRequests: [] as CacheEntry[],

    // Fetch errors
    errors: [] as any[],

    messageSearchPhase: null as string | null,
    messagesFor: '', // for what topic?
    messages: observable([] as TopicMessage[], { deep: false }),
    messagesElapsedMs: null as null | number,
    messagesBytesConsumed: 0,
    messagesTotalConsumed: 0,


    async startMessageSearch(_searchRequest: MessageSearchRequest): Promise<void> {
        const searchRequest = {
            ..._searchRequest, ...(appConfig.jwt ? {
                enterprise: {
                    redpandaCloud: {
                        accessToken: appConfig.jwt
                    }
                }
            } : {})
        }
        const url = `${appConfig.websocketBasePath}/topics/${searchRequest.topicName}/messages`;

        console.debug('connecting to "' + url + '"');

        // Abort previous connection
        if (currentWS != null)
            if (currentWS.readyState == WebSocket.OPEN || currentWS.readyState == WebSocket.CONNECTING)
                currentWS.close();

        currentWS = new WebSocket(url);
        const ws = currentWS;
        this.messageSearchPhase = 'Connecting';
        this.messagesBytesConsumed = 0;
        this.messagesTotalConsumed = 0;

        currentWS.onopen = _ev => {
            if (ws !== currentWS) return; // newer request has taken over
            // reset state for new request
            this.messagesFor = searchRequest.topicName;
            this.messages.length = 0;
            this.messagesElapsedMs = null;
            // send new request
            currentWS.send(JSON.stringify(searchRequest));
        };
        currentWS.onclose = ev => {
            if (ws !== currentWS) return;
            api.stopMessageSearch();
            // double assignment makes sense: when the phase changes to null, some observing components will play a "fade out" animation, using the last (non-null) value
            console.debug(`ws closed: code=${ev.code} wasClean=${ev.wasClean}` + (ev.reason ? ` reason=${ev.reason}` : ''));
        };

        const onMessageHandler = (msgEvent: MessageEvent) => {
            if (ws !== currentWS) return;
            const msg = JSON.parse(msgEvent.data);

            switch (msg.type) {
                case 'phase':
                    this.messageSearchPhase = msg.phase;
                    break;

                case 'progressUpdate':
                    this.messagesBytesConsumed = msg.bytesConsumed;
                    this.messagesTotalConsumed = msg.messagesConsumed;
                    break;

                case 'done':
                    this.messagesElapsedMs = msg.elapsedMs;
                    this.messagesBytesConsumed = msg.bytesConsumed;
                    // this.MessageSearchCancelled = msg.isCancelled;
                    this.messageSearchPhase = 'Done';
                    this.messageSearchPhase = null;
                    break;

                case 'error':
                    // error doesn't neccesarily mean the whole request is done
                    console.info('ws backend error: ' + msg.message);
                    const notificationKey = `errorNotification-${Date.now()}`;
                    notification['error']({
                        key: notificationKey,
                        message: 'Backend Error',
                        description: msg.message,
                        duration: 5,
                    });
                    break;

                case 'message':
                    const m = msg.message as TopicMessage;

                    const keyData = m.key.payload;
                    if (keyData != null && keyData != undefined && keyData != '' && m.key.encoding == 'binary') {
                        try {
                            m.key.payload = decodeBase64(m.key.payload); // unpack base64 encoded key
                        } catch (error) {
                            // Empty
                            // Only unpack if the key is base64 based
                        }
                    }

                    m.keyJson = JSON.stringify(m.key.payload);
                    m.valueJson = JSON.stringify(m.value.payload);

                    if (m.value.encoding == 'binary') {
                        m.value.payload = decodeBase64(m.value.payload);

                        const str = m.value.payload as string;
                        let hex = '';
                        for (let i = 0; i < str.length && i < 50; i++) {
                            let n = str.charCodeAt(i).toString(16);
                            if (n.length == 1) n = '0' + n;
                            hex += n + ' ';
                        }
                        m.valueBinHexPreview = hex;
                    }


                    //m = observable.object(m, undefined, { deep: false });

                    this.messages.push(m);
                    break;
            }
        };
        currentWS.onmessage = onMessageHandler;
    },

    stopMessageSearch() {
        if (currentWS) {
            currentWS.close();
            currentWS = null;
        }

        if (this.messageSearchPhase != null) {
            this.messageSearchPhase = 'Done';
            this.messagesBytesConsumed = 0;
            this.messagesTotalConsumed = 0;
            this.messageSearchPhase = null;
        }
    },

    refreshTopics(force?: boolean) {
        cachedApiRequest<GetTopicsResponse>(`${appConfig.restBasePath}/topics`, force)
            .then(v => {
                for (const t of v.topics) {
                    if (!t.allowedActions) continue;

                    // DEBUG: randomly remove some allowedActions
                    /*
                    const numToRemove = Math.round(Math.random() * t.allowedActions.length);
                    for (let i = 0; i < numToRemove; i++) {
                        const randomIndex = Math.round(Math.random() * (t.allowedActions.length - 1));
                        t.allowedActions.splice(randomIndex, 1);
                    }
                    */
                }
                this.topics = v.topics;
            }, addError);
    },

    async refreshTopicConfig(topicName: string, force?: boolean): Promise<void> {
        const promise = cachedApiRequest<TopicConfigResponse | null>(`${appConfig.restBasePath}/topics/${topicName}/configuration`, force)
            .then(v => {
                if (!v) {
                    this.topicConfig.delete(topicName);
                    return;
                }

                if (v.topicDescription.error) {
                    this.topicConfig.set(topicName, v.topicDescription);
                    return;
                }

                // add 'type' to each synonym
                // in the raw data, only the root entries have 'type', but the nested synonyms do not
                // we need 'type' on synonyms as well for filtering
                const topicDescription = v.topicDescription;
                prepareSynonyms(topicDescription.configEntries);
                this.topicConfig.set(topicName, topicDescription);

            }, addError); // 403 -> null
        return promise as Promise<void>;
    },

    async getTopicOffsetsByTimestamp(topicNames: string[], timestampUnixMs: number): Promise<TopicOffset[]> {
        const query = `topicNames=${encodeURIComponent(topicNames.join(','))}&timestamp=${timestampUnixMs}`;
        const response = await appConfig.fetch(`${appConfig.restBasePath}/topics-offsets?${query}`, {
            method: 'GET',
            headers: [
                ['Content-Type', 'application/json']
            ]
        });

        const r = await parseOrUnwrap<GetTopicOffsetsByTimestampResponse>(response, null);
        return r.topicOffsets;
    },

    refreshTopicDocumentation(topicName: string, force?: boolean) {
        cachedApiRequest<TopicDocumentationResponse>(`${appConfig.restBasePath}/topics/${topicName}/documentation`, force)
            .then(v => {
                const text = v.documentation.markdown == null ? null : decodeBase64(v.documentation.markdown);
                v.documentation.text = text;
                this.topicDocumentation.set(topicName, v.documentation);
            }, addError);
    },

    refreshTopicPermissions(topicName: string, force?: boolean) {
        if (!AppFeatures.SINGLE_SIGN_ON) return; // without SSO there can't be a permissions endpoint
        if (this.userData?.user?.providerID == -1) return; // debug user
        cachedApiRequest<TopicPermissions | null>(`${appConfig.restBasePath}/permissions/topics/${topicName}`, force)
            .then(x => this.topicPermissions.set(topicName, x), addError);
    },

    async deleteTopic(topicName: string) {
        return rest(`${appConfig.restBasePath}/topics/${encodeURIComponent(topicName)}`, { method: 'DELETE' }).catch(addError);
    },

    async deleteTopicRecords(topicName: string, offset: number, partitionId?: number) {
        const partitions = (partitionId != undefined) ? [{ partitionId, offset }] : this.topicPartitions?.get(topicName)?.map(partition => ({ partitionId: partition.id, offset }));

        if (!partitions || partitions.length === 0) {
            addError(new Error(`Topic ${topicName} doesn't have partitions.`));
            return;
        }

        return this.deleteTopicRecordsFromMultiplePartitionOffsetPairs(topicName, partitions);
    },

    async deleteTopicRecordsFromAllPartitionsHighWatermark(topicName: string) {
        const partitions = this.topicPartitions?.get(topicName)?.map(({ waterMarkHigh, id }) => ({
            partitionId: id,
            offset: waterMarkHigh
        }));

        if (!partitions || partitions.length === 0) {
            addError(new Error(`Topic ${topicName} doesn't have partitions.`));
            return;
        }

        return this.deleteTopicRecordsFromMultiplePartitionOffsetPairs(topicName, partitions);
    },

    async deleteTopicRecordsFromMultiplePartitionOffsetPairs(topicName: string, pairs: Array<{ partitionId: number, offset: number; }>) {
        return rest<DeleteRecordsResponseData>(`${appConfig.restBasePath}/topics/${topicName}/records`, {
            method: 'DELETE',
            headers: [
                ['Content-Type', 'application/json']
            ],
            body: JSON.stringify({ partitions: pairs })
        }).catch(addError);
    },

    refreshPartitions(topics: 'all' | string[] = 'all', force?: boolean): Promise<void> {
        if (Array.isArray(topics))
            // sort in order to maximize cache hits (todo: track/cache each topic individually instead)
            topics = topics.sort().map(t => encodeURIComponent(t));

        const url = topics == 'all'
            ? `${appConfig.restBasePath}/operations/topic-details`
            : `${appConfig.restBasePath}/operations/topic-details?topicNames=${topics.joinStr(',')}`;

        return cachedApiRequest<GetAllPartitionsResponse | null>(url, force)
            .then(response => {
                if (!response?.topics) return;
                transaction(() => {

                    const errors: {
                        topicName: string,
                        partitionErrors: { partitionId: number, error: string; }[],
                        waterMarkErrors: { partitionId: number, error: string; }[],
                    }[] = [];

                    for (const t of response.topics) {
                        if (t.error != null) {
                            // console.error(`refreshAllTopicPartitions: error for topic ${t.topicName}: ${t.error}`);
                            continue;
                        }

                        // If any partition has any errors, don't set the result for that topic
                        const partitionErrors = [];
                        const waterMarkErrors = [];
                        for (const p of t.partitions) {
                            // topicName
                            p.topicName = t.topicName;

                            let partitionHasError = false;
                            if (p.partitionError) {
                                partitionErrors.push({ partitionId: p.id, error: p.partitionError });
                                partitionHasError = true;
                            } if (p.waterMarksError) {
                                waterMarkErrors.push({ partitionId: p.id, error: p.waterMarksError });
                                partitionHasError = true;
                            }
                            if (partitionHasError) {
                                p.hasErrors = true;
                                continue;
                            }

                            // Add some local/cached properties to make working with the data easier
                            const validLogDirs = p.partitionLogDirs.filter(e => !e.error && e.size >= 0);
                            const replicaSize = validLogDirs.length > 0 ? validLogDirs.max(e => e.size) : 0;
                            p.replicaSize = replicaSize >= 0 ? replicaSize : 0;
                        }

                        // Set partition
                        this.topicPartitions.set(t.topicName, t.partitions);

                        if (partitionErrors.length == 0 && waterMarkErrors.length == 0) {

                        } else {
                            errors.push({
                                topicName: t.topicName,
                                partitionErrors: partitionErrors,
                                waterMarkErrors: waterMarkErrors,
                            });
                        }
                    }

                    // if (errors.length > 0)
                    //     console.error('refreshAllTopicPartitions: response had errors', errors);
                });
            }, addError);
    },

    refreshPartitionsForTopic(topicName: string, force?: boolean) {
        cachedApiRequest<GetPartitionsResponse | null>(`${appConfig.restBasePath}/topics/${topicName}/partitions`, force)
            .then(response => {
                if (response?.partitions) {
                    const partitionErrors: Array<{ id: number, partitionError: string; }> = [], waterMarksErrors: Array<{ id: number, waterMarksError: string; }> = [];


                    // Add some local/cached properties to make working with the data easier
                    for (const p of response.partitions) {
                        // topicName
                        p.topicName = topicName;

                        if (p.partitionError) partitionErrors.push({ id: p.id, partitionError: p.partitionError });
                        if (p.waterMarksError) waterMarksErrors.push({ id: p.id, waterMarksError: p.waterMarksError });
                        if (partitionErrors.length || waterMarksErrors.length) continue;

                        // replicaSize
                        const validLogDirs = p.partitionLogDirs.filter(e => (e.error == null || e.error == '') && e.size >= 0);
                        const replicaSize = validLogDirs.length > 0 ? validLogDirs.max(e => e.size) : 0;
                        p.replicaSize = replicaSize >= 0 ? replicaSize : 0;
                    }

                    if (partitionErrors.length == 0 && waterMarksErrors.length == 0) {
                        // Set partitions
                        this.topicPartitionErrors.delete(topicName);
                        this.topicWatermarksErrors.delete(topicName);
                        this.topicPartitions.set(topicName, response.partitions);
                    } else {
                        this.topicPartitionErrors.set(topicName, partitionErrors);
                        this.topicWatermarksErrors.set(topicName, waterMarksErrors);
                        console.error(`refreshPartitionsForTopic: response has partition errors (t=${topicName} p=${partitionErrors.length}, w=${waterMarksErrors.length})`);
                    }

                } else {
                    // Set null to indicate that we're not allowed to see the partitions
                    this.topicPartitions.set(topicName, null);
                    return;
                }

                let partitionErrors = 0, waterMarkErrors = 0;

                // Add some local/cached properties to make working with the data easier
                for (const p of response.partitions) {
                    // topicName
                    p.topicName = topicName;

                    if (p.partitionError) partitionErrors++;
                    if (p.waterMarksError) waterMarkErrors++;
                    if (partitionErrors || waterMarkErrors) {
                        p.hasErrors = true;
                        continue;
                    }

                    // replicaSize
                    const validLogDirs = p.partitionLogDirs.filter(e => (e.error == null || e.error == '') && e.size >= 0);
                    const replicaSize = validLogDirs.length > 0 ? validLogDirs.max(e => e.size) : 0;
                    p.replicaSize = replicaSize >= 0 ? replicaSize : 0;
                }

                // Set partitions
                this.topicPartitions.set(topicName, response.partitions);

                if (partitionErrors > 0 || waterMarkErrors > 0)
                    console.warn(`refreshPartitionsForTopic: response has partition errors (topic=${topicName} partitionErrors=${partitionErrors}, waterMarkErrors=${waterMarkErrors})`);
            }, addError);
    },

    refreshTopicAcls(topicName: string, force?: boolean) {
        const query = aclRequestToQuery({ ...AclRequestDefault, resourcePatternTypeFilter: 'Match', resourceType: 'Topic', resourceName: topicName });
        cachedApiRequest<GetAclOverviewResponse | null>(`${appConfig.restBasePath}/acls?${query}`, force)
            .then(v => {
                if (v)
                    normalizeAcls(v.aclResources);
                this.topicAcls.set(topicName, v);
            });
    },

    refreshTopicConsumers(topicName: string, force?: boolean) {
        cachedApiRequest<GetTopicConsumersResponse>(`${appConfig.restBasePath}/topics/${topicName}/consumers`, force)
            .then(v => this.topicConsumers.set(topicName, v.topicConsumers), addError);
    },

    async refreshAcls(request: GetAclsRequest, force?: boolean): Promise<void> {
        const query = aclRequestToQuery(request);
        await cachedApiRequest<GetAclOverviewResponse | null>(`${appConfig.restBasePath}/acls?${query}`, force)
            .then(v => {
                if (v) {
                    normalizeAcls(v.aclResources);
                    this.ACLs = v;
                }
                else {
                    this.ACLs = null;
                }
            }, addError);
    },

    refreshQuotas(force?: boolean) {
        cachedApiRequest<QuotaResponse | null>(`${appConfig.restBasePath}/quotas`, force)
            .then(v => this.Quotas = v ?? null, addError);
    },

    async refreshSupportedEndpoints(): Promise<EndpointCompatibilityResponse | null> {
        const r = await rest<EndpointCompatibilityResponse>(`${appConfig.restBasePath}/console/endpoints`);
        if (!r)
            return null;
        this.endpointCompatibility = r.endpointCompatibility;
        this.licenses = r.licenses;
        return r;
    },

    refreshCluster(force?: boolean) {
        cachedApiRequest<ClusterInfoResponse>(`${appConfig.restBasePath}/cluster`, force)
            .then(v => {
                transaction(() => {
                    // add 'type' to each synonym entry
                    for (const broker of v.clusterInfo.brokers)
                        if (broker.config && !broker.config.error)
                            prepareSynonyms(broker.config.configs);

                    // don't assign if the value didn't change
                    // we'd re-trigger all observers!
                    // TODO: it would probably be easier to just annotate 'clusterInfo' with a structural comparer
                    if (!comparer.structural(this.clusterInfo, v.clusterInfo))
                        this.clusterInfo = v.clusterInfo;

                    for (const b of v.clusterInfo.brokers)
                        if (b.config.error)
                            this.brokerConfigs.set(b.brokerId, b.config.error);
                        else
                            this.brokerConfigs.set(b.brokerId, b.config.configs);
                });
            }, addError);
    },

    refreshBrokerConfig(brokerId: number, force?: boolean) {
        cachedApiRequest<BrokerConfigResponse>(`${appConfig.restBasePath}/brokers/${brokerId}/config`, force)
            .then(v => {
                prepareSynonyms(v.brokerConfigs);
                this.brokerConfigs.set(brokerId, v.brokerConfigs);
            })
            .catch(err => {
                this.brokerConfigs.set(brokerId, String(err));
            });
    },

    refreshConsumerGroup(groupId: string, force?: boolean) {
        cachedApiRequest<GetConsumerGroupResponse>(`${appConfig.restBasePath}/consumer-groups/${groupId}`, force)
            .then(v => {
                addFrontendFieldsForConsumerGroup(v.consumerGroup);
                this.consumerGroups.set(v.consumerGroup.groupId, v.consumerGroup);
            }, addError);
    },

    refreshConsumerGroups(force?: boolean) {
        cachedApiRequest<GetConsumerGroupsResponse>(`${appConfig.restBasePath}/consumer-groups`, force)
            .then(v => {
                for (const g of v.consumerGroups)
                    addFrontendFieldsForConsumerGroup(g);

                transaction(() => {
                    this.consumerGroups.clear();
                    for (const g of v.consumerGroups)
                        this.consumerGroups.set(g.groupId, g);
                });
            }, addError);
    },

    refreshConsumerGroupAcls(groupName: string, force?: boolean) {
        const query = aclRequestToQuery({ ...AclRequestDefault, resourcePatternTypeFilter: 'Match', resourceType: 'Group', resourceName: groupName });
        cachedApiRequest<GetAclOverviewResponse | null>(`${appConfig.restBasePath}/acls?${query}`, force)
            .then(v => {
                if (v) {
                    normalizeAcls(v.aclResources);
                }
                this.consumerGroupAcls.set(groupName, v);
            });
    },

    async editConsumerGroupOffsets(groupId: string, topics: EditConsumerGroupOffsetsTopic[]):
        Promise<EditConsumerGroupOffsetsResponseTopic[]> {
        const request: EditConsumerGroupOffsetsRequest = {
            groupId: groupId,
            topics: topics
        };

        const response = await appConfig.fetch(`${appConfig.restBasePath}/consumer-groups/${encodeURIComponent(groupId)}`, {
            method: 'PATCH',
            headers: [
                ['Content-Type', 'application/json']
            ],
            body: toJson(request),
        });

        const r = await parseOrUnwrap<EditConsumerGroupOffsetsResponse>(response, null);
        return r.topics;
    },

    async deleteConsumerGroupOffsets(groupId: string, topics: DeleteConsumerGroupOffsetsTopic[]):
        Promise<DeleteConsumerGroupOffsetsResponseTopic[]> {
        const request: DeleteConsumerGroupOffsetsRequest = {
            groupId: groupId,
            topics: topics
        };

        const response = await appConfig.fetch(`${appConfig.restBasePath}/consumer-groups/${encodeURIComponent(groupId)}/offsets`, {
            method: 'DELETE',
            headers: [
                ['Content-Type', 'application/json']
            ],
            body: toJson(request),
        });

        const r = await parseOrUnwrap<DeleteConsumerGroupOffsetsResponse>(response, null);
        return r.topics;
    },

    async deleteConsumerGroup(groupId: string): Promise<void> {
        const response = await appConfig.fetch(`${appConfig.restBasePath}/consumer-groups/${encodeURIComponent(groupId)}`, {
            method: 'DELETE',
            headers: [
                ['Content-Type', 'application/json']
            ]
        });

        await parseOrUnwrap<void>(response, null);
    },


    refreshAdminInfo(force?: boolean) {
        cachedApiRequest<AdminInfo | null>(`${appConfig.restBasePath}/admin`, force)
            .then(info => {
                if (info == null) {
                    this.adminInfo = null;
                    return;
                }

                // normalize responses (missing arrays, or arrays with an empty string)
                // todo: not needed anymore, responses are always correct now
                for (const role of info.roles)
                    for (const permission of role.permissions)
                        for (const k of ['allowedActions', 'includes', 'excludes']) {
                            const ar: string[] = (permission as any)[k] ?? [];
                            (permission as any)[k] = ar.filter(x => x.length > 0);
                        }

                // resolve role of each binding
                for (const binding of info.roleBindings) {
                    binding.resolvedRole = info.roles.first(r => r.name == binding.roleName)!;
                    if (binding.resolvedRole == null) console.error('could not resolve roleBinding to role: ' + toJson(binding));
                }

                // resolve bindings, and roles of each user
                for (const user of info.users) {
                    user.bindings = user.bindingIds.map(id => info.roleBindings.first(rb => rb.ephemeralId == id)!);
                    if (user.bindings.any(b => b == null)) console.error('one or more rolebindings could not be resolved for user: ' + toJson(user));

                    user.grantedRoles = [];
                    for (const roleName in user.audits)
                        user.grantedRoles.push({
                            role: info.roles.first(r => r.name == roleName)!,
                            grantedBy: user.audits[roleName].map(bindingId => info.roleBindings.first(b => b.ephemeralId == bindingId)!),
                        });
                }

                this.adminInfo = info;
            }, addError);
    },

    refreshSchemaOverview(force?: boolean) {
        const rq = cachedApiRequest(`${appConfig.restBasePath}/schemas`, force) as Promise<SchemaOverviewResponse>;
        return rq
            .then(({ schemaOverview, isConfigured }) => [this.schemaOverview, this.schemaOverviewIsConfigured] = [schemaOverview, isConfigured])
            .catch(addError);
    },

    refreshSchemaDetails(subjectName: string, version: number | 'latest', force?: boolean) {
        if (version == null) version = 'latest';

        const rq = cachedApiRequest(`${appConfig.restBasePath}/schemas/subjects/${encodeURIComponent(subjectName)}/versions/${version}`, force) as Promise<SchemaDetailsResponse>;

        return rq
            .then(({ schemaDetails }) => {
                if (schemaDetails && typeof schemaDetails.schema === 'string' && schemaDetails.type != SchemaType.PROTOBUF) {
                    schemaDetails.schema = JSON.parse(schemaDetails.schema);
                }

                if (schemaDetails && schemaDetails.schema) {
                    if (typeof schemaDetails.schema === 'string')
                        schemaDetails.rawSchema = schemaDetails.schema;
                    else
                        schemaDetails.rawSchema = JSON.stringify(schemaDetails.schema);
                }

                this.schemaDetails = schemaDetails;
            })
            .catch(addError);
    },

    refreshPartitionReassignments(force?: boolean): Promise<void> {
        return cachedApiRequest<PartitionReassignmentsResponse | null>(`${appConfig.restBasePath}/operations/reassign-partitions`, force)
            .then(v => {
                if (v === null)
                    this.partitionReassignments = null;
                else
                    this.partitionReassignments = v.topics;
            }, addError);
    },

    async startPartitionReassignment(request: PartitionReassignmentRequest): Promise<AlterPartitionReassignmentsResponse> {
        const response = await appConfig.fetch(`${appConfig.restBasePath}/operations/reassign-partitions`, {
            method: 'PATCH',
            headers: [
                ['Content-Type', 'application/json']
            ],
            body: toJson(request),
        });
        return await parseOrUnwrap<AlterPartitionReassignmentsResponse>(response, null);
    },

    async setReplicationThrottleRate(brokerIds: number[], maxBytesPerSecond: number): Promise<PatchConfigsResponse> {

        maxBytesPerSecond = Math.ceil(maxBytesPerSecond);

        const configRequest: PatchConfigsRequest = { resources: [] };

        for (const b of brokerIds) {
            configRequest.resources.push({
                resourceType: ConfigResourceType.Broker,
                resourceName: String(b),
                configs: [
                    { name: 'leader.replication.throttled.rate', op: AlterConfigOperation.Set, value: String(maxBytesPerSecond) },
                    { name: 'follower.replication.throttled.rate', op: AlterConfigOperation.Set, value: String(maxBytesPerSecond) },
                ]
            });
        }

        return await this.changeConfig(configRequest);
    },

    async setThrottledReplicas(
        topicReplicas: {
            topicName: string,
            leaderReplicas: { brokerId: number, partitionId: number; }[],
            followerReplicas: { brokerId: number, partitionId: number; }[];
        }[]): Promise<PatchConfigsResponse> {

        const configRequest: PatchConfigsRequest = { resources: [] };

        for (const t of topicReplicas) {
            const res: ResourceConfig = { // Set which topics to throttle
                resourceType: ConfigResourceType.Topic,
                resourceName: t.topicName,
                configs: [],
            };

            const leaderReplicas = t.leaderReplicas.map(e => `${e.partitionId}:${e.brokerId}`).join(',');
            res.configs.push({ name: 'leader.replication.throttled.replicas', op: AlterConfigOperation.Set, value: leaderReplicas });
            const followerReplicas = t.followerReplicas.map(e => `${e.partitionId}:${e.brokerId}`).join(',');
            res.configs.push({ name: 'follower.replication.throttled.replicas', op: AlterConfigOperation.Set, value: followerReplicas });

            // individual request for each topic
            configRequest.resources.push(res);
        }

        return await this.changeConfig(configRequest);
    },

    async resetThrottledReplicas(topicNames: string[]): Promise<PatchConfigsResponse> {

        const configRequest: PatchConfigsRequest = { resources: [] };

        // reset throttled replicas for those topics
        for (const t of topicNames) {
            configRequest.resources.push({
                resourceType: ConfigResourceType.Topic,
                resourceName: t,
                configs: [
                    { name: 'leader.replication.throttled.replicas', op: AlterConfigOperation.Delete },
                    { name: 'follower.replication.throttled.replicas', op: AlterConfigOperation.Delete }
                ],
            });
        }

        return await this.changeConfig(configRequest);
    },

    async resetReplicationThrottleRate(brokerIds: number[]): Promise<PatchConfigsResponse> {

        const configRequest: PatchConfigsRequest = { resources: [] };

        // We currently only set replication throttle on each broker, instead of cluster-wide (same effect, but different kind of 'ConfigSource')
        // So we don't remove the cluster-wide setting, only the ones we've set (the per-broker) settings

        // remove throttle configs from all brokers (DYNAMIC_DEFAULT_BROKER_CONFIG)
        // configRequest.resources.push({
        //     resourceType: ConfigResourceType.Broker,
        //     resourceName: "", // empty = all brokers
        //     configs: [
        //         { name: 'leader.replication.throttled.rate', op: AlterConfigOperation.Delete },
        //         { name: 'follower.replication.throttled.rate', op: AlterConfigOperation.Delete },
        //     ]
        // });

        // remove throttle configs from each broker individually (DYNAMIC_BROKER_CONFIG)
        for (const b of brokerIds) {
            configRequest.resources.push({
                resourceType: ConfigResourceType.Broker,
                resourceName: String(b),
                configs: [
                    { name: 'leader.replication.throttled.rate', op: AlterConfigOperation.Delete },
                    { name: 'follower.replication.throttled.rate', op: AlterConfigOperation.Delete },
                ]
            });
        }

        return await this.changeConfig(configRequest);
    },

    async changeConfig(request: PatchConfigsRequest): Promise<PatchConfigsResponse> {
        const response = await appConfig.fetch(`${appConfig.restBasePath}/operations/configs`, {
            method: 'PATCH',
            headers: [
                ['Content-Type', 'application/json']
            ],
            body: toJson(request),
        });
        return await parseOrUnwrap<PatchConfigsResponse>(response, null);
    },


    async refreshConnectClusters(force?: boolean): Promise<void> {
        return cachedApiRequest<KafkaConnectors | null>(`${appConfig.restBasePath}/kafka-connect/connectors`, force)
            .then(v => {
                // backend error
                if (!v) {
                    this.connectConnectors = undefined;
                    return;
                }

                // not configured
                if (!v.clusters) {
                    this.connectConnectors = v;
                    return;
                }

                // prepare helper properties
                for (const cluster of v.clusters)
                    addFrontendFieldsForConnectCluster(cluster);

                this.connectConnectors = v;
            }, addError);
    },

    // PATCH /topics/{topicName}/configuration   //
    // PATCH /topics/configuration               // default config
    async changeTopicConfig(topicName: string | null, configs: PatchTopicConfigsRequest['configs']): Promise<void> {
        const url = topicName
            ? `${appConfig.restBasePath}/topics/${topicName}/configuration`
            : `${appConfig.restBasePath}/topics/configuration`;

        const response = await appConfig.fetch(url, {
            method: 'PATCH',
            headers: [
                ['Content-Type', 'application/json']
            ],
            body: toJson({ configs }),
        });
        await parseOrUnwrap<void>(response, null);
    },

    // AdditionalInfo = list of plugins
    refreshClusterAdditionalInfo(clusterName: string, force?: boolean): void {
        cachedApiRequest<ClusterAdditionalInfo | null>(`${appConfig.restBasePath}/kafka-connect/clusters/${clusterName}`, force)
            .then(v => {
                if (!v) {
                    this.connectAdditionalClusterInfo.delete(clusterName);
                }
                else {
                    this.connectAdditionalClusterInfo.set(clusterName, v);
                }
            }, addError);
    },

    /*
    Commented out for now!
    There are some issues with refreshing a single connector:
        - We might not have the cluster/connector cached (can happen when a user visits the details page directly)
        - Updating the inner details (e.g. running tasks) won't update the cached total/running tasks in the cluster object
          which might make things pretty confusing for a user (pausing a connector, then going back to the overview page).
          One solution would be to update all clusters/connectors, which defeats the purpose of refreshing only one.
          The real solution would be to not have pre-computed fields.


    // Details for one connector
    async refreshConnectorDetails(clusterName: string, connectorName: string, force?: boolean): Promise<void> {

        const existingCluster = this.connectConnectors?.clusters?.find(x => x.clusterName == clusterName);
        if (!existingCluster)
            // if we don't have any info yet, or we don't know about that cluster, we need a full refresh
            return this.refreshConnectClusters(force);

        return cachedApiRequest<ClusterConnectorInfo | null>(`${appConfig.restBasePath}/kafka-connect/clusters/${clusterName}/connectors/${connectorName}`, force)
            .then(v => {
                if (!v) return; // backend error

                const cluster = this.connectConnectors?.clusters?.find(x => x.clusterName == clusterName);
                if (!cluster) return; // did we forget about the cluster somehow?

                const connector = cluster.connectors.

                // update given clusters
                runInAction(() => {
                    const clusters = this.connectConnectors?.clusters;
                    if (!v.clusters) return; // shouldn't happen: this method shouldn't get called if we don't already have info cached
                    if (!clusters) return; // shouldn't happen: if we don't have clusters locally we'd have refreshed them

                    for (const updatedCluster of v.clusters) {
                        addFrontendFieldsForConnectCluster(updatedCluster);

                        const index = clusters.findIndex(x => x.clusterName == updatedCluster.clusterName);
                        if (index < 0) {
                            // shouldn't happen, if we don't know the cluster, then how would we have requested new info for it?
                            clusters.push(updatedCluster);
                        } else {
                            // overwrite existing cluster with new data
                            clusters[index] = updatedCluster;
                        }
                    }
                });

            }, addError);
    },
*/
    /*
        // All, or for specific cluster
        refreshConnectors(clusterName?: string, force?: boolean): Promise<void> {
            const url = clusterName == null
                ? './api/kafka-connect/connectors'
                : `${appConfig.restBasePath}/kafka-connect/clusters/${clusterName}/connectors`;
            return cachedApiRequest<KafkaConnectors | null>(url, force)
                .then(v => {
                    if (v == null) {

                    }
                }, addError);
        },



    */

    async deleteConnector(clusterName: string, connector: string): Promise<void> {
        // DELETE "/kafka-connect/clusters/{clusterName}/connectors/{connector}"
        const response = await appConfig.fetch(`${appConfig.restBasePath}/kafka-connect/clusters/${clusterName}/connectors/${connector}`, {
            method: 'DELETE',
            headers: [
                ['Content-Type', 'application/json']
            ]
        });
        return parseOrUnwrap<void>(response, null);
    },

    async pauseConnector(clusterName: string, connector: string): Promise<void> {
        // PUT  "/kafka-connect/clusters/{clusterName}/connectors/{connector}/pause"  (idempotent)
        const response = await appConfig.fetch(`${appConfig.restBasePath}/kafka-connect/clusters/${clusterName}/connectors/${connector}/pause`, {
            method: 'PUT',
            headers: [
                ['Content-Type', 'application/json']
            ]
        });
        return parseOrUnwrap<void>(response, null);
    },

    async resumeConnector(clusterName: string, connector: string): Promise<void> {
        // PUT  "/kafka-connect/clusters/{clusterName}/connectors/{connector}/resume" (idempotent)
        const response = await appConfig.fetch(`${appConfig.restBasePath}/kafka-connect/clusters/${clusterName}/connectors/${connector}/resume`, {
            method: 'PUT',
            headers: [
                ['Content-Type', 'application/json']
            ]
        });
        return parseOrUnwrap<void>(response, null);
    },

    async restartConnector(clusterName: string, connector: string): Promise<void> {
        // POST "/kafka-connect/clusters/{clusterName}/connectors/{connector}/restart"
        const response = await appConfig.fetch(`${appConfig.restBasePath}/kafka-connect/clusters/${clusterName}/connectors/${connector}/restart`, {
            method: 'POST',
            headers: [
                ['Content-Type', 'application/json']
            ]
        });
        return parseOrUnwrap<void>(response, null);
    },

    async updateConnector(clusterName: string, connector: string, config: object): Promise<void> {
        // PUT "/kafka-connect/clusters/{clusterName}/connectors/{connector}"
        const response = await appConfig.fetch(`${appConfig.restBasePath}/kafka-connect/clusters/${clusterName}/connectors/${connector}`, {
            method: 'PUT',
            headers: [
                ['Content-Type', 'application/json']
            ],
            body: JSON.stringify({ config: config }),
        });
        return parseOrUnwrap<void>(response, null);
    },

    async restartTask(clusterName: string, connector: string, taskID: number): Promise<void> {
        // POST "/kafka-connect/clusters/{clusterName}/connectors/{connector}/tasks/{taskID}/restart"
        const response = await appConfig.fetch(`${appConfig.restBasePath}/kafka-connect/clusters/${clusterName}/connectors/${connector}/tasks/${String(taskID)}/restart`, {
            method: 'POST',
            headers: [
                ['Content-Type', 'application/json']
            ]
        });

        return parseOrUnwrap<void>(response, null);
    },

    async validateConnectorConfig(clusterName: string, pluginClassName: string, config: object): Promise<ConnectorValidationResult> {
        // PUT "/kafka-connect/clusters/{clusterName}/connector-plugins/{pluginClassName}/config/validate"
        const response = await appConfig.fetch(`${appConfig.restBasePath}/kafka-connect/clusters/${encodeURIComponent(clusterName)}/connector-plugins/${encodeURIComponent(pluginClassName)}/config/validate`, {
            method: 'PUT',
            headers: [
                ['Content-Type', 'application/json']
            ],
            body: JSON.stringify(config),
        });
        return parseOrUnwrap<ConnectorValidationResult>(response, null);
    },

    async createConnector(clusterName: string, connectorName: string, pluginClassName: string, config: object): Promise<void> {
        // POST "/kafka-connect/clusters/{clusterName}/connectors"
        const response = await appConfig.fetch(`${appConfig.restBasePath}/kafka-connect/clusters/${clusterName}/connectors`, {
            method: 'POST',
            headers: [
                ['Content-Type', 'application/json']
            ],
            body: JSON.stringify({
                connectorName: connectorName,
                config: config
            }),
        });
        return parseOrUnwrap<void>(response, null);
    },

    async publishRecords(request: PublishRecordsRequest): Promise<ProduceRecordsResponse> {
        // POST "/topics-records"
        const response = await appConfig.fetch(`${appConfig.restBasePath}/topics-records`, {
            method: 'POST',
            headers: [
                ['Content-Type', 'application/json']
            ],
            body: JSON.stringify(request),
        });
        return parseOrUnwrap<ProduceRecordsResponse>(response, null);
    },

    async createTopic(request: CreateTopicRequest): Promise<CreateTopicResponse> {
        // POST "/topics"
        const response = await appConfig.fetch(`${appConfig.restBasePath}/topics`, {
            method: 'POST',
            headers: [
                ['Content-Type', 'application/json']
            ],
            body: JSON.stringify(request),
        });
        return parseOrUnwrap<CreateTopicResponse>(response, null);
    },

    async createACL(request: CreateACLRequest): Promise<void> {
        const response = await appConfig.fetch(`${appConfig.restBasePath}/acls`, {
            method: 'POST',
            headers: [
                ['Content-Type', 'application/json']
            ],
            body: JSON.stringify(request),
        });

        return parseOrUnwrap<void>(response, null);
    },

    async deleteACLs(request: DeleteACLsRequest): Promise<void> {
        const response = await appConfig.fetch(`${appConfig.restBasePath}/acls`, {
            method: 'DELETE',
            headers: [
                ['Content-Type', 'application/json']
            ],
            body: JSON.stringify(request),
        });

        return parseOrUnwrap<void>(response, null);
    },

    async refreshServiceAccounts(force?: boolean): Promise<void> {
        await cachedApiRequest<GetUsersResponse | null>(`${appConfig.restBasePath}/users`, force)
            .then(v => this.serviceAccounts = v ?? null, addError);
    },

    async createServiceAccount(request: CreateUserRequest): Promise<void> {
        const response = await appConfig.fetch(`${appConfig.restBasePath}/users`, {
            method: 'POST',
            headers: [
                ['Content-Type', 'application/json']
            ],
            body: JSON.stringify(request),
        });

        return parseOrUnwrap<void>(response, null);
    },

    async deleteServiceAccount(principalId: string): Promise<void> {
        const response = await appConfig.fetch(`${appConfig.restBasePath}/users/${principalId}`, {
            method: 'DELETE',
        });

        return parseOrUnwrap<void>(response, null);
    },

    async createSecret(clusterName: string, connectorName: string, secretValue: string): Promise<any> {
        return rest(`${appConfig.restBasePath}/kafka-connect/clusters/${clusterName}/secrets`, {
            method: 'POST',
            headers: [
                ['Content-Type', 'application/json']
            ],
            body: JSON.stringify({
                connectorName,
                clusterName,
                secretData: secretValue,
                labels: {
                    component: 'connectors'
                }
            }),
        });
    },
};

function addFrontendFieldsForConnectCluster(cluster: ClusterConnectors) {
    const allowedActions = cluster.allowedActions ?? ['all'];
    const allowAll = allowedActions.includes('all');

    cluster.canViewCluster = allowAll || allowedActions.includes('viewConnectCluster');
    cluster.canEditCluster = allowAll || allowedActions.includes('editConnectCluster');
    cluster.canDeleteCluster = allowAll || allowedActions.includes('deleteConnectCluster');

    for (const connector of cluster.connectors)
        if (connector.config)
            connector.jsonConfig = JSON.stringify(connector.config, undefined, 4);
        else
            connector.jsonConfig = '';
}

function addFrontendFieldsForConsumerGroup(g: GroupDescription) {
    g.lagSum = g.topicOffsets.sum(o => o.summedLag);

    if (g.allowedActions) {
        if (g.allowedActions.includes('all')) {
            // All perms
        } else {
            // Not all perms, set helper props
            g.noEditPerms = !g.allowedActions?.includes('editConsumerGroup');
            g.noDeletePerms = !g.allowedActions?.includes('deleteConsumerGroup');
        }
    }
    g.isInUse = g.state.toLowerCase() != 'empty';
}

export const brokerMap = computed(() => {
    const brokers = api.clusterInfo?.brokers;
    if (brokers == null) return null;

    const map = new Map<number, Broker>();
    for (const b of brokers)
        map.set(b.brokerId, b);

    return map;
}, { name: 'brokerMap', equals: comparer.structural });


// 1. add 'type' to each synonym, so when expanding a config entry (to view its synonyms), we can still see the type
// 2. remove redundant synonym entries (those that have the same source as the root config entry)
function prepareSynonyms(configEntries: ConfigEntry[]) {
    if (!Array.isArray(configEntries)) return;

    for (const e of configEntries) {
        if (e.synonyms == undefined)
            continue;

        // remove redundant entry
        if (e.synonyms.length > 0)
            if (e.synonyms[0].source == e.source)
                e.synonyms.splice(0, 1);

        if (e.synonyms.length == 0) {
            // delete empty arrays, otherwise Tables will show this entry as 'expandable' even though it has no children
            delete e.synonyms;
            continue;
        }

        // add 'type' from root object
        for (const s of e.synonyms)
            s.type = e.type;
    }
}

function normalizeAcls(acls: AclResource[]) {
    function upperFirst(str: string): string {
        if (!str) return str;
        const lower = str.toLowerCase();
        const first = lower[0];
        const result = first.toUpperCase() + lower.slice(1);
        return result;
    }

    const specialCaseMap = {
        'TRANSACTIONAL_ID': 'TransactionalID'
    } as { [key: string]: string; };

    function normalizeStringEnum<T extends string>(str: T): T {
        if (!str)
            return str;
        if (specialCaseMap[str])
            return specialCaseMap[str] as T;

        const parts = str.split('_');
        for (let i = 0; i < parts.length; i++) {
            parts[i] = upperFirst(parts[i].toLowerCase());
        }
        const result = parts.join('');
        return result as T;
    }

    for (const e of acls) {
        e.resourceType = normalizeStringEnum(e.resourceType);
        e.resourcePatternType = normalizeStringEnum(e.resourcePatternType);

        for (const acl of e.acls) {
            acl.operation = normalizeStringEnum(acl.operation);
            acl.permissionType = normalizeStringEnum(acl.permissionType);
        }
    }
}

export function aclRequestToQuery(request: GetAclsRequest): string {
    const filters = ObjToKv(request).filter(kv => !!kv.value);
    const query = filters.map(x => `${x.key}=${x.value}`).join('&');
    return query;
}

export async function partialTopicConfigs(configKeys: string[], topics?: string[]): Promise<PartialTopicConfigsResponse> {
    const keys = configKeys.map(k => encodeURIComponent(k)).join(',');
    const topicNames = topics?.map(t => encodeURIComponent(t)).join(',');
    const query = topicNames
        ? `topicNames=${topicNames}&configKeys=${keys}`
        : `configKeys=${keys}`;

    const response = await appConfig.fetch(`${appConfig.restBasePath}/topics-configs?${query}`);
    return parseOrUnwrap<PartialTopicConfigsResponse>(response, null);
}

export interface MessageSearchRequest {
    topicName: string,
    startOffset: number,
    partitionId: number,
    maxResults: number, // should also support '-1' soon, so we can do live tailing
    filterInterpreterCode: string, // js code, base64 encoded
    enterprise?: {
        redpandaCloud?: {
            accessToken: string;
        }
    }
}

async function parseOrUnwrap<T>(response: Response, text: string | null): Promise<T> {
    let obj: undefined | any = undefined;
    if (text === null) {
        if (response.bodyUsed)
            throw new Error('response content already consumed');
        text = await response.text();
    }
    try {
        obj = JSON.parse(text);
    } catch { }

    // api error?
    if (isApiError(obj))
        throw new WrappedApiError(response, obj);

    // server/proxy error?
    if (!response.ok) {
        text = text?.trim() ?? '';
        throw new Error(`${response.status} (${text ?? response.statusText})`);
    }

    // server/proxy error?
    if (!response.ok) {
        text = text?.trim() ?? '';
        throw new Error(`${response.status} (${text ?? response.statusText})`);
    }

    return obj as T;
}

function addError(err: Error) {
    api.errors.push(err);
}


type apiStoreType = typeof apiStore;
export const api = observable(apiStore, { messages: observable.shallow }) as apiStoreType;
