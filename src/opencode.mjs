import { validModelId, modelBudget, isKimiK3Model } from './models.mjs';

function availableModels(models) {
  if (!Array.isArray(models)) throw new Error('模型目录无效');
  const selfHosted = models.filter(model =>
    validModelId(model?.id)
    && model.root_ai_type === 'xinference' && model.owned_by === 'shanghaitech'
    && model.primary !== false
  );
  if (!selfHosted.length) throw new Error('没有可用的校内部署模型');
  return selfHosted;
}

function modelName(model) {
  const name = typeof model.display_name === 'string' && model.display_name.trim()
    ? model.display_name.trim() : model.id;
  return name.toLowerCase() === model.id.toLowerCase() ? name : `${name} (${model.id})`;
}

export function opencodeConfig(models, baseURL, apiKey) {
  const selfHosted = availableModels(models);
  const preferred = selfHosted.find(isKimiK3Model) || selfHosted[0];
  const entries = selfHosted.map(model => [model.id, { name: modelName(model), limit: modelBudget(model) }]);
  return {
    $schema: 'https://opencode.ai/config.json',
    model: `shtech/${preferred.id}`,
    provider: {
      shtech: {
        npm: '@ai-sdk/openai-compatible',
        name: 'ShanghaiTech GenAI',
        options: { baseURL, apiKey },
        models: Object.fromEntries(entries)
      }
    }
  };
}

export function opencodeV2Config(models, baseURL, apiKey) {
  const selfHosted = availableModels(models);
  const preferred = selfHosted.find(isKimiK3Model) || selfHosted[0];
  const entries = selfHosted.map(model => [model.id, {
    modelID: model.id,
    name: modelName(model),
    capabilities: {
      tools: Boolean(model.capabilities?.tools),
      input: model.capabilities?.vision ? ['text', 'image'] : ['text'],
      output: ['text']
    },
    limit: modelBudget(model)
  }]);
  return {
    $schema: 'https://opencode.ai/config.json',
    model: `shtech/${preferred.id}`,
    providers: {
      shtech: {
        name: 'ShanghaiTech GenAI',
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL, apiKey },
        models: Object.fromEntries(entries)
      }
    }
  };
}
