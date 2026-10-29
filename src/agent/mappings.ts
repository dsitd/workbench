import type { ModelMessage, ModelRequest } from '../shared/agent';
import { nativeStrictSchema } from '../shared/tool-schema';
import type { Json } from './http';
import { checkedReasoning, isOpenRouter, providerId } from './reasoning';
import { anthropicReasoning, chatReasoning, requestEffort } from './provider-policy';
import { applyCachePolicy, promptCacheCapability } from './cache-policy';

const imageUrl = (image: { mimeType: string; base64: string }) => `data:${image.mimeType};base64,${image.base64}`;
function wireTool(request: ModelRequest, tool: ModelRequest['tools'][number]) {
  const strict = nativeStrictSchema(request.model.baseUrl, tool);
  return { name: tool.name, description: tool.description, parameters: strict ?? tool.parameters, strict: Boolean(strict) };
}

export function chatBody(request: ModelRequest): Json {
  const messages: Json[] = [{ role: 'system', content: request.system }];
  const cacheCandidates = new Set<Json>();
  let pendingImages: Json[] = [];
  let pendingImagesCacheable = true;
  for (let index = 0; index < request.messages.length; index++) {
    const message = request.messages[index];
    const mapped: Json = { role: message.role, content: message.content || null };
    if (message.role === 'assistant' && message.providerId === providerId(request.model)) {
      const retained = checkedReasoning(message.reasoningDetails, request.apiKey);
      if (retained?.length) mapped.reasoning_details = retained;
    }
    if (message.toolCalls?.length) mapped.tool_calls = message.toolCalls.map(call => ({
      id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }));
    if (message.role === 'tool') {
      mapped.tool_call_id = message.toolCallId;
      mapped.content = message.content;
      if (message.images?.length) {
        pendingImages.push(...message.images.map(image => ({ type: 'image_url', image_url: { url: imageUrl(image), detail: image.detail ?? 'low' } })));
        if (message.contextData) pendingImagesCacheable = false;
      }
    } else if (message.images?.length) {
      mapped.content = [{ type: 'text', text: message.content }, ...message.images.map(image => ({ type: 'image_url', image_url: { url: imageUrl(image), detail: image.detail ?? 'low' } }))];
    }
    messages.push(mapped);
    if (!message.contextData && ['user', 'tool'].includes(message.role)) cacheCandidates.add(mapped);
    if (pendingImages.length && request.messages[index + 1]?.role !== 'tool') {
      const images = { role: 'user', content: [{ type: 'text', text: 'Images selected by inspect_image, in tool-result order.' }, ...pendingImages] };
      messages.push(images);
      if (pendingImagesCacheable) cacheCandidates.add(images);
      pendingImages = [];
      pendingImagesCacheable = true;
    }
  }
  return applyCachePolicy(request, {
    model: request.model.model, messages, stream: true,
    ...chatReasoning(request),
    stream_options: { include_usage: true },
    ...(request.providerPriceLimit && isOpenRouter(request.model.baseUrl) ? { provider: { max_price: request.providerPriceLimit } } : {}),
    ...(/^https:\/\/api\.openai\.com\//.test(request.model.baseUrl + '/')
      ? { max_completion_tokens: request.model.maxOutputTokens }
      : { max_tokens: request.model.maxOutputTokens }),
    ...(request.tools.length ? { tools: request.tools.map(tool => ({ type: 'function', function: wireTool(request, tool) })) } : {}),
  }, 'chat', cacheCandidates);
}

export function responsesBody(request: ModelRequest): Json {
  const input: Json[] = [];
  const cacheCandidates = new Set<Json>();
  for (const message of request.messages) {
    const start = input.length;
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content });
      if (message.images?.length) input.push({ role: 'user', content: imageContent(message, 'input_text', 'input_image') });
      if (!message.contextData) for (const item of input.slice(start)) cacheCandidates.add(item);
      continue;
    }
    const retained = message.providerId === providerId(request.model) ? message.providerItems : undefined;
    if (retained?.length) input.push(...retained);
    if (message.content && !retained?.some(item => item.type === 'message')) {
      // Cross-protocol/plain assistant history is an EasyInputMessage. A full
      // output_text message requires provider-assigned id/type fields; only
      // actual providerItems above can be replayed in that output-item form.
      input.push({ role: message.role, content: message.role === 'assistant' ? message.content : [{ type: 'input_text', text: message.content }] });
    }
    if (message.images?.length) input.push({ role: 'user', content: imageContent(message, 'input_text', 'input_image') });
    if (!retained?.some(item => item.type === 'function_call')) {
      for (const call of message.toolCalls ?? []) input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) });
    }
    if (!message.contextData && message.role === 'user') for (const item of input.slice(start)) cacheCandidates.add(item);
  }
  const noReasoningLuna = request.reasoningEnabled === false
    && ['openai/gpt-6-luna', 'gpt-6-luna'].includes(request.model.model)
    && promptCacheCapability(request.model).strategy === 'openai-explicit';
  return applyCachePolicy(request, {
    model: request.model.model, instructions: request.system, input,
    max_output_tokens: request.model.maxOutputTokens, stream: true, store: false,
    ...(noReasoningLuna ? { reasoning: { effort: 'none' } }
      : requestEffort(request) ? { reasoning: { effort: requestEffort(request) } } : {}),
    include: ['reasoning.encrypted_content'],
    tools: request.tools.map(tool => ({ type: 'function', ...wireTool(request, tool) })),
  }, 'responses', cacheCandidates);
}

function imageContent(message: ModelMessage, textType: string, imageType: string): Json[] {
  return [{ type: textType, text: message.content || 'Selected image' }, ...(message.images ?? []).map(image => ({ type: imageType, image_url: imageUrl(image), detail: image.detail ?? 'low' }))];
}

export function anthropicBody(request: ModelRequest): Json {
  const messages: Json[] = [];
  const cacheCandidates = new Set<Json>();
  for (const message of request.messages) {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content: Json[] = [];
    const images = (message.images ?? []).map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.base64 } }));
    if (message.role === 'tool') {
      content.push({ type: 'tool_result', tool_use_id: message.toolCallId,
        content: [{ type: 'text', text: message.content }, ...images],
        is_error: Boolean((message as ModelMessage & { error?: boolean }).error),
      });
    } else if (role === 'assistant' && message.providerId === providerId(request.model) && message.providerItems?.length) {
      content.push(...message.providerItems);
    } else {
      if (message.content) content.push({ type: 'text', text: message.content });
      content.push(...images);
      content.push(...(message.toolCalls ?? []).map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments })));
    }
    if (!content.length) continue;
    if (!message.contextData && role === 'user') for (const block of content) cacheCandidates.add(block);
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else messages.push({ role, content });
  }
  return applyCachePolicy(request, {
    model: request.model.model, system: request.system, messages,
    max_tokens: request.model.maxOutputTokens, stream: true,
    ...anthropicReasoning(request),
    tools: request.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })),
  }, 'anthropic', cacheCandidates);
}
