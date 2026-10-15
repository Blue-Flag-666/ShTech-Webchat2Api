// Recovery for webchat backends that reject structured agent histories. Preserve
// every historical field and tool result, while sending one ordinary user turn.
export function textHistoryRequest(request, chatGroupId = request.chatGroupId) {
  if (!Array.isArray(request.messages) || !request.messages.length) return null;
  // Keep leading system instructions at their original authority. The complete
  // transcript below also preserves later dynamic instructions and tool history.
  const prefix=[];
  for(const message of request.messages){if(message.role!=='system')break;prefix.push({...message});}
  return { ...request, messages: prefix,
    chatInfo: `Conversation history (JSON transcript with original role labels):\n${JSON.stringify(request.messages)}\n\nCurrent request and instructions:\n${request.chatInfo}`,
    ...(chatGroupId ? { chatGroupId } : {}) };
}
