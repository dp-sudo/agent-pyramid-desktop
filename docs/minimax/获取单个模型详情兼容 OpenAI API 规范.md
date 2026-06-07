> ## Documentation Index
> Fetch the complete documentation index at: https://platform.minimaxi.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# 获取单个模型详情

> 获取指定模型的详细信息，兼容 OpenAI API 规范。



## OpenAPI

````yaml /api-reference/models/openai/api/retrieve-model.json GET /v1/models/{model_id}
openapi: 3.1.0
info:
  title: MiniMax Models API
  description: MiniMax models API compatible with OpenAI API specification.
  version: 1.0.0
servers:
  - url: https://api.minimaxi.com
security:
  - bearerAuth: []
paths:
  /v1/models/{model_id}:
    get:
      tags:
        - Models
      summary: 获取单个模型详情
      description: 获取指定模型的详细信息。
      operationId: retrieveModel
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
                  object:
                    type: string
                    description: 对象类型，固定为 `"model"`
                  created:
                    type: integer
                    description: 模型创建时间（Unix 时间戳）
                  owned_by:
                    type: string
                    description: 模型所属组织
              examples:
                默认响应:
                  value:
                    id: MiniMax-M3
                    object: model
                    created: 1780272000
                    owned_by: minimax
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
      description: |-
        `HTTP: Bearer Auth`
         - Security Scheme Type: http
         - HTTP Authorization Scheme: Bearer API_key，用于验证账户信息，可在 [账户管理>接口密钥](https://platform.minimaxi.com/user-center/basic-information/interface-key) 中查看

````