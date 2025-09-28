/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {PerformanceInsightFormatter} from 'chrome-devtools-frontend/front_end/models/ai_assistance/data_formatters/PerformanceInsightFormatter.js';
import {PerformanceTraceFormatter} from 'chrome-devtools-frontend/front_end/models/ai_assistance/data_formatters/PerformanceTraceFormatter.js';
import {AgentFocus} from 'chrome-devtools-frontend/front_end/models/ai_assistance/performance/AIContext.js';
import * as TraceEngine from 'chrome-devtools-frontend/front_end/models/trace/trace.js';

import {logger} from '../logger.js';

export type InsightName = string;

export interface TraceSuccessResult {
  parsedTrace: unknown;
  insights: Map<unknown, {model?: Record<string, unknown>}> | null;
}

export interface TraceErrorResult {
  error: string;
}

export type TraceParsingResult = TraceSuccessResult | TraceErrorResult;

export type TraceResult = TraceSuccessResult;

const traceModel = TraceEngine.TraceModel.Model.createWithAllHandlers();

export function traceResultIsSuccess(
  result: TraceParsingResult,
): result is TraceSuccessResult {
  return 'parsedTrace' in result;
}

export async function parseRawTraceBuffer(
  buffer: Uint8Array<ArrayBufferLike> | undefined,
): Promise<TraceParsingResult> {
  traceModel.resetProcessor();
  if (!buffer) {
    return {
      error: 'No buffer was provided.',
    };
  }

  const asString = new TextDecoder().decode(buffer);
  if (!asString) {
    return {
      error: 'Decoding the trace buffer returned an empty string.',
    };
  }

  try {
    const parsedJson = JSON.parse(asString);
    const events = Array.isArray(parsedJson) ? parsedJson : parsedJson.traceEvents;
    await traceModel.parse(events);

    const parsedTrace = traceModel.parsedTrace();
    if (!parsedTrace) {
      return {
        error: 'No parsed trace was returned from the trace engine.',
      };
    }

    const insights = (parsedTrace as {insights?: TraceSuccessResult['insights']})?.insights ?? null;
    return {
      parsedTrace,
      insights,
    } satisfies TraceSuccessResult;
  } catch (error) {
    const errorText = error instanceof Error ? error.message : JSON.stringify(error);
    logger(`Unexpeced error parsing trace: ${errorText}`);
    return {
      error: errorText,
    };
  }
}

const extraFormatDescriptions = `Information on performance traces may contain main thread activity represented as call frames and network requests.\n\n${PerformanceTraceFormatter.callFrameDataFormatDescription}\n\n${PerformanceTraceFormatter.networkDataFormatDescription}\n`;

export function getTraceSummary(result: TraceSuccessResult): string {
  const focus = AgentFocus.fromParsedTrace(result.parsedTrace as any);
  const formatter = new PerformanceTraceFormatter(focus);
  const output = formatter.formatTraceSummary();
  return `${extraFormatDescriptions}\n\n${output}`;
}

export function getInsightOutput(
  result: TraceSuccessResult,
  insightName: InsightName,
): {output: string} | {error: string} {
  if (!result.insights) {
    return {
      error: 'No Performance insights are available for this trace.',
    };
  }

  const mainNavigationId =
    (result.parsedTrace as {
      data?: {
        Meta?: {
          mainFrameNavigations?: Array<{
            args?: {data?: {navigationId?: string}};
          }>;
        };
      };
    })?.data?.Meta?.mainFrameNavigations?.at(0)?.args?.data?.navigationId;

  const insightsForNav = result.insights.get(
    mainNavigationId ?? TraceEngine.Types.Events.NO_NAVIGATION,
  ) as {model?: Record<string, unknown>} | undefined;

  if (!insightsForNav) {
    return {
      error: 'No Performance Insights for this trace.',
    };
  }

  const matchingInsight = insightsForNav.model?.[insightName] as unknown;
  if (!matchingInsight) {
    return {
      error: `No Insight with the name ${insightName} found. Double check the name you provided is accurate and try again.`,
    };
  }

  const formatter = new PerformanceInsightFormatter(
    AgentFocus.fromParsedTrace(result.parsedTrace as any),
    matchingInsight as any,
  );
  return {output: formatter.formatInsight()};
}
