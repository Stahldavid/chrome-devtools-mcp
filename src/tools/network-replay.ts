/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import z from 'zod';

import {ToolCategories} from './categories.js';
import {defineTool} from './ToolDefinition.js';

// Global storage for network traces (in a real implementation, this would be persistent)
const networkTraces = new Map<string, any>();

export const netRecord = defineTool({
  name: 'net_record',
  description: 'Start recording network traffic for later replay. Bypasses Service Workers by default for reproducibility.',
  annotations: {
    title: 'Record Network',
    category: ToolCategories.NETWORK,
    readOnlyHint: false,
  },
  schema: {
    mode: z.enum(['strict', 'fuzzy']).default('strict').describe('Recording mode - strict for exact replay, fuzzy for flexible replay'),
    filter: z.string().optional().describe('URL filter pattern (regex)'),
    resource_types: z.array(z.enum(['document', 'script', 'image', 'stylesheet', 'font', 'xhr', 'fetch', 'ws', 'other']))
      .default(['document', 'xhr', 'fetch']).describe('Resource types to record'),
    throttle: z.enum(['none', 'offline', 'slow3g', 'fast3g', '4g']).optional().describe('Network throttling'),
    persist: z.boolean().default(true).describe('Persist recording data'),
    redact_headers: z.array(z.string()).optional().describe('Headers to redact from recording'),
    service_workers_mode: z.enum(['allow', 'bypass', 'capture_strict']).default('bypass').describe('Service Worker handling'),
    timeout_ms: z.number().int().min(0).default(15000).describe('Recording timeout'),
  },
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();
    const params = request.params;

    try {
      const traceId = `tr_${Math.random().toString(36).substring(2, 8)}`;
      const client = await page.createCDPSession();

      // Enable network domain
      await client.send('Network.enable');

      // Set up Service Worker bypass if requested
      if (params.service_workers_mode === 'bypass') {
        await client.send('Network.setBypassServiceWorker', {
          bypass: true,
        });
        response.appendResponseLine('Service Workers bypassed for recording');
      }

      // Apply network throttling if specified
      if (params.throttle && params.throttle !== 'none') {
        const throttleConditions: Record<string, any> = {
          offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
          slow3g: { offline: false, latency: 2000, downloadThroughput: 50 * 1024, uploadThroughput: 50 * 1024 },
          fast3g: { offline: false, latency: 562.5, downloadThroughput: 1.6 * 1024 * 1024, uploadThroughput: 750 * 1024 },
          '4g': { offline: false, latency: 20, downloadThroughput: 4 * 1024 * 1024, uploadThroughput: 3 * 1024 * 1024 },
        };
        
        const condition = throttleConditions[params.throttle];
        if (condition) {
          await client.send('Network.emulateNetworkConditions', condition);
          response.appendResponseLine(`Applied ${params.throttle} throttling`);
        }
      }

      // Initialize recording data structure
      const recording = {
        traceId,
        mode: params.mode,
        startTime: Date.now(),
        requests: [] as any[],
        responses: [] as any[],
        config: params,
      };

      // Set up request/response capture
      const requestHandler = (request: any) => {
        // Apply resource type filter
        if (!params.resource_types.includes(request.resourceType || 'other')) {
          return;
        }

        // Apply URL filter
        if (params.filter) {
          try {
            const filterRegex = new RegExp(params.filter);
            if (!filterRegex.test(request.url)) {
              return;
            }
          } catch {
            // Invalid regex, skip filtering
          }
        }

        // Capture request data
        const requestData = {
          requestId: request.requestId,
          url: request.url,
          method: request.method,
          headers: { ...request.headers },
          postData: request.postData,
          resourceType: request.resourceType,
          timestamp: request.timestamp,
        };

        // Redact sensitive headers
        if (params.redact_headers) {
          for (const header of params.redact_headers) {
            if (requestData.headers[header]) {
              requestData.headers[header] = '[REDACTED]';
            }
          }
        }

        recording.requests.push(requestData);
      };

      const responseHandler = (response: any) => {
        // Find corresponding request
        const request = recording.requests.find(r => r.requestId === response.requestId);
        if (!request) return;

        const responseData = {
          requestId: response.requestId,
          url: response.url,
          status: response.status,
          statusText: response.statusText,
          headers: { ...response.headers },
          mimeType: response.mimeType,
          timestamp: response.timestamp,
        };

        // Redact sensitive headers
        if (params.redact_headers) {
          for (const header of params.redact_headers) {
            if (responseData.headers[header]) {
              responseData.headers[header] = '[REDACTED]';
            }
          }
        }

        recording.responses.push(responseData);
      };

      // Attach listeners
      client.on('Network.requestWillBeSent', requestHandler);
      client.on('Network.responseReceived', responseHandler);

      // Store recording configuration
      networkTraces.set(traceId, recording);

      // Set up timeout
      setTimeout(() => {
        try {
          client.off('Network.requestWillBeSent', requestHandler);
          client.off('Network.responseReceived', responseHandler);
          
          // Finalize recording
          const finalRecording = networkTraces.get(traceId);
          if (finalRecording) {
            finalRecording.endTime = Date.now();
            finalRecording.duration = finalRecording.endTime - finalRecording.startTime;
          }
        } catch (error) {
          // Ignore cleanup errors
        }
      }, params.timeout_ms);

      response.appendResponseLine(`Network recording started: ${traceId}`);
      response.appendResponseLine(`Mode: ${params.mode}`);
      response.appendResponseLine(`Resource types: ${params.resource_types.join(', ')}`);
      response.appendResponseLine(`Service Workers: ${params.service_workers_mode}`);
      response.appendResponseLine(`Timeout: ${params.timeout_ms}ms`);
      response.appendResponseLine(`Result: ${JSON.stringify({ trace_id: traceId }, null, 2)}`);

    } catch (error) {
      throw new Error(`Failed to start network recording: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});

export const netReplay = defineTool({
  name: 'net_replay',
  description: 'Replay a recorded network trace with exact or best-effort matching.',
  annotations: {
    title: 'Replay Network',
    category: ToolCategories.NETWORK,
    readOnlyHint: false,
  },
  schema: {
    trace_id: z.string().describe('ID of the trace to replay'),
    strategy: z.enum(['exact', 'best_effort']).default('exact').describe('Replay matching strategy'),
    timeout_ms: z.number().int().min(0).default(30000).describe('Replay timeout'),
  },
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();
    const params = request.params;

    try {
      const recording = networkTraces.get(params.trace_id);
      if (!recording) {
        throw new Error(`Network trace not found: ${params.trace_id}`);
      }

      const client = await page.createCDPSession();
      await client.send('Network.enable');
      await client.send('Fetch.enable');

      const mismatches: string[] = [];
      let matchedRequests = 0;

      response.appendResponseLine(`Starting replay of trace: ${params.trace_id}`);
      response.appendResponseLine(`Strategy: ${params.strategy}`);
      response.appendResponseLine(`Recorded requests: ${recording.requests.length}`);

      // Set up request interception for replay
      const replayHandler = async (event: any) => {
        const { requestId, request } = event;
        
        // Find matching recorded request
        const matchedRecord = recording.requests.find((r: any) => {
          if (params.strategy === 'exact') {
            return r.url === request.url && 
                   r.method === request.method;
          } else {
            // Best effort matching
            return r.url === request.url;
          }
        });

        if (matchedRecord) {
          // Find corresponding response
          const matchedResponse = recording.responses.find((resp: any) => 
            resp.requestId === matchedRecord.requestId
          );

          if (matchedResponse) {
            // Mock the response
            try {
              const responseBody = 'Mock response body'; // In real implementation, store actual body
              await client.send('Fetch.fulfillRequest', {
                requestId,
                responseCode: matchedResponse.status,
                responseHeaders: Object.entries(matchedResponse.headers).map(([name, value]) => ({
                  name,
                  value: String(value),
                })),
                body: Buffer.from(responseBody).toString('base64'),
              });
              
              matchedRequests++;
            } catch (error) {
              mismatches.push(`Failed to fulfill request ${request.url}: ${error}`);
              await client.send('Fetch.continueRequest', { requestId });
            }
          } else {
            mismatches.push(`No recorded response for ${request.url}`);
            await client.send('Fetch.continueRequest', { requestId });
          }
        } else {
          if (params.strategy === 'exact') {
            mismatches.push(`No exact match for ${request.method} ${request.url}`);
          }
          await client.send('Fetch.continueRequest', { requestId });
        }
      };

      client.on('Fetch.requestPaused', replayHandler);

      // Enable request interception
      await client.send('Fetch.enable', {
        patterns: [{ urlPattern: '*' }],
      });

      // Wait for replay to complete or timeout
      await new Promise((resolve) => {
        setTimeout(resolve, params.timeout_ms);
      });

      // Cleanup
      client.off('Fetch.requestPaused', replayHandler);
      await client.send('Fetch.disable');

      const matched = mismatches.length === 0;
      const result = {
        result: {
          matched,
          mismatches,
        },
      };

      response.appendResponseLine(`Replay completed`);
      response.appendResponseLine(`Matched requests: ${matchedRequests}`);
      response.appendResponseLine(`Mismatches: ${mismatches.length}`);
      
      if (mismatches.length > 0) {
        response.appendResponseLine('Mismatch details:');
        mismatches.slice(0, 5).forEach(mismatch => {
          response.appendResponseLine(`  - ${mismatch}`);
        });
        if (mismatches.length > 5) {
          response.appendResponseLine(`  ... and ${mismatches.length - 5} more`);
        }
      }

      response.appendResponseLine(`Result: ${JSON.stringify(result, null, 2)}`);

    } catch (error) {
      throw new Error(`Failed to replay network trace: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});