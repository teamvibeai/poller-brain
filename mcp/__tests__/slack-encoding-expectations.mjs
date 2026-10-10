// Encoding confirmed for methods called by slackApi() in slack.mjs.
// Keep this independent of JSON_SAFE_METHODS and needsFormEncoding(): a new
// call site must be classified explicitly before the encoding tests pass.
export const expectedEncoding = {
  'assistant.threads.setStatus': 'json',
  'auth.test': 'json',
  'bookmarks.list': 'json',
  'chat.getPermalink': 'form',
  'chat.postMessage': 'json',
  'chat.update': 'json',
  'conversations.history': 'form',
  'conversations.info': 'form',
  'conversations.list': 'form',
  'conversations.replies': 'form',
  'conversations.setPurpose': 'form',
  'conversations.setTopic': 'form',
  'files.completeUploadExternal': 'form',
  'files.getUploadURLExternal': 'form',
  'pins.add': 'json',
  'pins.list': 'form',
  'pins.remove': 'json',
  'reactions.add': 'json',
  'reactions.get': 'form',
  'reactions.remove': 'json',
  'users.info': 'form',
  'users.list': 'form',
}
