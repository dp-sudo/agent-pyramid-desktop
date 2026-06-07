> ## Documentation Index
> Fetch the complete documentation index at: https://platform.minimaxi.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Token 估算

> 估算请求的输入 token 数，不真正调用模型生成。常用于在调用主接口前评估请求成本与是否触发上下文长度上限。



## OpenAPI

````yaml /api-reference/text/api/openapi-responses.json POST /v1/responses/input_tokens
openapi: 3.1.0
info:
  title: MiniMax Responses API
  description: MiniMax OpenAI Responses API 兼容接口，支持对话生成和 Token 估算
  license:
    name: MIT
  version: 1.0.0
servers:
  - url: https://api.minimaxi.com
security:
  - bearerAuth: []
paths:
  /v1/responses/input_tokens:
    post:
      tags:
        - Responses
      summary: Token 估算
      operationId: estimateInputTokens
      parameters:
        - name: Content-Type
          in: header
          required: true
          description: 请求体的媒介类型，请设置为 `application/json`，确保请求数据的格式为 JSON
          schema:
            type: string
            enum:
              - application/json
            default: application/json
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/EstimateInputTokensReq'
            examples:
              Request:
                value:
                  model: MiniMax-M3
                  input:
                    - type: message
                      role: user
                      content: >-
                        请帮我用 Python 实现一个支持泛型的快速排序算法，要求：1) 原地排序节省内存；2)
                        处理重复元素时使用三路划分；3) 小数组切换到插入排序优化；4)
                        提供完整的单元测试。最后还请解释一下三路划分相比经典 Lomuto 划分在重复键场景下的优势。
                  tools:
                    - type: function
                      name: search_docs
                      description: 搜索 Python 标准库或第三方库的官方文档
                      parameters:
                        type: object
                        properties:
                          library:
                            type: string
                            description: 库名称，如 `typing`、`itertools`
                          query:
                            type: string
                            description: 搜索关键词
                        required:
                          - library
                          - query
                    - type: function
                      name: run_python
                      description: 在沙箱中执行 Python 代码，返回标准输出和错误信息
                      parameters:
                        type: object
                        properties:
                          code:
                            type: string
                            description: 要执行的 Python 代码
                          timeout_seconds:
                            type: integer
                            description: 执行超时时间（秒）
                            default: 10
                        required:
                          - code
        required: true
      responses:
        '200':
          description: 成功响应
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/EstimateInputTokensResp'
              examples:
                Response:
                  value:
                    object: response.input_tokens
                    input_tokens: 588
components:
  schemas:
    EstimateInputTokensReq:
      type: object
      required:
        - model
        - input
      properties:
        model:
          type: string
          description: 调用的模型名称，如 `MiniMax-M3`
          example: MiniMax-M3
        input:
          description: 对话内容，支持简单文本或完整对话历史数组
          oneOf:
            - type: string
              description: 简单文本输入
            - type: array
              description: 完整对话历史
              items:
                $ref: '#/components/schemas/InputItem'
        instructions:
          type: string
          description: 系统指令
        tools:
          type: array
          description: 工具列表
          items:
            $ref: '#/components/schemas/Tool'
        tool_choice:
          type: string
          enum:
            - none
            - auto
          description: 工具选择策略：`none` 表示不调用任何工具；`auto` 表示由模型自动判断是否调用工具
        text:
          type: object
          description: 输出格式控制
          properties:
            format:
              type: object
              properties:
                type:
                  type: string
                  enum:
                    - text
                  default: text
                  description: 输出格式类型
        reasoning:
          type: object
          description: >-
            推理控制。对于 MiniMax-M3，默认开启推理，响应会包含 reasoning 输出项。设置 `effort` 为 `none`
            可关闭 MiniMax-M3 的推理输出。`minimal`、`low`、`medium` 和 `high`
            这些取值会被兼容接收并保持推理开启，但不会调节 MiniMax-M3 的推理深度。对于 M2.x 模型，推理无法关闭。
          properties:
            effort:
              type: string
              enum:
                - minimal
                - low
                - medium
                - high
                - none
              description: >-
                推理控制值。对于 MiniMax-M3，`none` 会关闭推理输出。`minimal`、`low`、`medium` 和
                `high` 会保持推理开启，但不会调节 MiniMax-M3 的推理深度。对于 M2.x 模型，推理仍会保持开启。
          required: []
    EstimateInputTokensResp:
      type: object
      required:
        - object
        - input_tokens
      properties:
        object:
          type: string
          enum:
            - response.input_tokens
          description: 对象类型，固定为 `response.input_tokens`
        input_tokens:
          type: integer
          description: 估算的输入 token 数
    InputItem:
      type: object
      description: >-
        对话历史条目。`type` 字段决定具体形态：`message`（默认）/ `function_call` /
        `function_call_output` / `reasoning`
      properties:
        type:
          type: string
          enum:
            - message
            - function_call
            - function_call_output
            - reasoning
          default: message
          description: 条目类型
        role:
          type: string
          enum:
            - user
            - assistant
            - system
            - developer
            - tool
          description: 消息角色（仅当 `type` 为 `message` 时使用）
        content:
          description: 消息内容，可以是字符串或多模态片段数组（仅当 `type` 为 `message` 时使用）
          oneOf:
            - type: string
            - type: array
              items:
                $ref: '#/components/schemas/ContentPart'
        call_id:
          type: string
          description: 工具调用 ID（仅当 `type` 为 `function_call` 或 `function_call_output` 时使用）
        name:
          type: string
          description: 函数名（仅当 `type` 为 `function_call` 时使用）
        arguments:
          type: string
          description: 函数参数的 JSON 字符串（仅当 `type` 为 `function_call` 时使用）
        output:
          description: 工具返回结果（仅当 `type` 为 `function_call_output` 时使用）
          oneOf:
            - type: string
            - type: array
              items:
                $ref: '#/components/schemas/ContentPart'
        summary:
          type: array
          description: 思维链段落数组（仅当 `type` 为 `reasoning` 时使用）
          items:
            type: object
            properties:
              type:
                type: string
                enum:
                  - summary_text
              text:
                type: string
                description: 思维链文本
    Tool:
      type: object
      required:
        - type
        - name
      properties:
        type:
          type: string
          enum:
            - function
          description: 工具类型
        name:
          type: string
          description: 函数名称
        description:
          type: string
          description: 函数说明，用于模型判断何时调用
        parameters:
          type: object
          description: 函数参数定义，使用 JSON Schema 格式
    ContentPart:
      type: object
      required:
        - type
      description: 消息内容片段
      properties:
        type:
          type: string
          enum:
            - input_text
            - output_text
            - input_image
            - input_video
          description: |-
            内容片段类型：
            - `input_text` / `output_text`: 文本片段
            - `input_image`: 图片输入
            - `input_video`: 视频输入
        text:
          type: string
          description: 文本内容（当 `type` 为 `input_text` / `output_text` 时）
        image_url:
          description: 图片输入（当 `type` 为 `input_image` 时）。支持的格式：JPEG、PNG、GIF、WEBP
          oneOf:
            - type: string
            - type: object
              required:
                - url
              properties:
                url:
                  type: string
                  description: 图片链接或 Base64 编码
                detail:
                  type: string
                  enum:
                    - low
                    - default
                    - high
                  default: default
                  description: 图片理解的精细度档位
        video_url:
          description: 视频输入（当 `type` 为 `input_video` 时）。支持的格式：MP4、AVI、MOV、MKV
          oneOf:
            - type: string
            - type: object
              required:
                - url
              properties:
                url:
                  type: string
                  description: 视频链接或 Base64 编码，大文件建议使用 File API 上传
                fps:
                  type: number
                  format: float
                  default: 1
                  minimum: 0.2
                  maximum: 5
                  description: 抽帧频率
                detail:
                  type: string
                  enum:
                    - low
                    - default
                    - high
                  default: default
                  description: 视频理解的精细度档位
                max_long_side_pixel:
                  type: integer
                  description: 视频帧最长边的像素约束
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