> ## Documentation Index
> Fetch the complete documentation index at: https://platform.minimaxi.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# 获取单个模型详情

> 获取指定模型的详细信息，兼容 Anthropic API 规范。



## OpenAPI

````yaml /api-reference/models/anthropic/api/retrieve-model.json GET /anthropic/v1/models/{model_id}
openapi: 3.1.0
info:
  title: MiniMax Models API
  description: MiniMax models API compatible with Anthropic API specification.
  version: 1.0.0
servers:
  - url: https://api.minimaxi.com
security:
  - apiKeyAuth: []
paths:
  /anthropic/v1/models/{model_id}:
    get:
      tags:
        - Models
      summary: 获取单个模型详情
      description: 获取指定模型的详细信息。
      operationId: anthropicRetrieveModel
      parameters:
        - name: model_id
          in: path
          required: true
          description: 模型标识符
          schema:
            type: string
      responses:
        '200':
          description: 指定模型的详细信息。
          content:
            application/json:
              schema:
                type: object
                properties:
                  id:
                    type: string
                    description: 模型标识符
                  created_at:
                    type: string
                    description: 模型创建时间（ISO 8601 格式）
                  display_name:
                    type: string
                    description: 模型显示名称
                  type:
                    type: string
                    description: 模型类型，固定为 `"model"`
              examples:
                默认响应:
                  value:
                    id: MiniMax-M3
                    created_at: '2026-06-01T00:00:00Z'
                    display_name: MiniMax-M3
                    type: model
components:
  securitySchemes:
    apiKeyAuth:
      type: apiKey
      in: header
      name: X-Api-Key
      description: |-
        `API Key Auth`
         - Security Scheme Type: apiKey
         - API Key Header: X-Api-Key，用于验证账户信息，可在 [账户管理>接口密钥](https://platform.minimaxi.com/user-center/basic-information/interface-key) 中查看

````