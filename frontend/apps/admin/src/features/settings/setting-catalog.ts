export interface SettingChoice {namespace:string;key:string;label:string;group:string;editable:boolean;type:string;values?:string[];minimum?:string;maximum?:string}
export const settingChoices:SettingChoice[]=[
  {
    "namespace": "auth_toggle",
    "key": "email_enabled",
    "label": "邮箱注册开关",
    "group": "注册与赠送",
    "editable": true,
    "type": "boolean"
  },
  {
    "namespace": "auth_toggle",
    "key": "phone_enabled",
    "label": "手机注册开关",
    "group": "注册与赠送",
    "editable": true,
    "type": "boolean"
  },
  {
    "namespace": "auth_toggle",
    "key": "gift_enabled",
    "label": "赠送会员开关",
    "group": "注册与赠送",
    "editable": true,
    "type": "boolean"
  },
  {
    "namespace": "auth_toggle",
    "key": "gift_plan",
    "label": "赠送会员套餐",
    "group": "注册与赠送",
    "editable": true,
    "type": "enum",
    "values": [
      "free",
      "plus",
      "pro"
    ]
  },
  {
    "namespace": "auth_toggle",
    "key": "gift_duration",
    "label": "赠送期限",
    "group": "注册与赠送",
    "editable": true,
    "type": "integer",
    "minimum": "1",
    "maximum": "3650"
  },
  {
    "namespace": "auth_toggle",
    "key": "gift_duration_unit",
    "label": "赠送期限单位",
    "group": "注册与赠送",
    "editable": true,
    "type": "enum",
    "values": [
      "days",
      "months",
      "years"
    ]
  },
  {
    "namespace": "plan_prices",
    "key": "plus_month",
    "label": "Plus月付价格",
    "group": "会员价格",
    "editable": true,
    "type": "integer",
    "minimum": "1",
    "maximum": "1000000"
  },
  {
    "namespace": "plan_prices",
    "key": "plus_year",
    "label": "Plus年付价格",
    "group": "会员价格",
    "editable": true,
    "type": "integer",
    "minimum": "1",
    "maximum": "1000000"
  },
  {
    "namespace": "plan_prices",
    "key": "pro_month",
    "label": "Pro月付价格",
    "group": "会员价格",
    "editable": true,
    "type": "integer",
    "minimum": "1",
    "maximum": "1000000"
  },
  {
    "namespace": "plan_prices",
    "key": "pro_year",
    "label": "Pro年付价格",
    "group": "会员价格",
    "editable": true,
    "type": "integer",
    "minimum": "1",
    "maximum": "1000000"
  },
  {
    "namespace": "plan_prices",
    "key": "plus_month_original",
    "label": "Plus月付原价",
    "group": "会员价格",
    "editable": true,
    "type": "integer",
    "minimum": "0",
    "maximum": "1000000"
  },
  {
    "namespace": "plan_prices",
    "key": "plus_year_original",
    "label": "Plus年付原价",
    "group": "会员价格",
    "editable": true,
    "type": "integer",
    "minimum": "0",
    "maximum": "1000000"
  },
  {
    "namespace": "plan_prices",
    "key": "pro_month_original",
    "label": "Pro月付原价",
    "group": "会员价格",
    "editable": true,
    "type": "integer",
    "minimum": "0",
    "maximum": "1000000"
  },
  {
    "namespace": "plan_prices",
    "key": "pro_year_original",
    "label": "Pro年付原价",
    "group": "会员价格",
    "editable": true,
    "type": "integer",
    "minimum": "0",
    "maximum": "1000000"
  },
  {
    "namespace": "crypto_wallet",
    "key": "payment_mode",
    "label": "收款模式",
    "group": "收款",
    "editable": true,
    "type": "enum",
    "values": [
      "fixed"
    ]
  },
  {
    "namespace": "crypto_wallet",
    "key": "fixed_tron_address",
    "label": "波场收款地址",
    "group": "收款",
    "editable": false,
    "type": "string"
  },
  {
    "namespace": "crypto_wallet",
    "key": "fixed_erc20_address",
    "label": "以太坊收款地址",
    "group": "收款",
    "editable": false,
    "type": "string"
  },
  {
    "namespace": "crypto_wallet",
    "key": "fixed_bep20_address",
    "label": "币安链收款地址",
    "group": "收款",
    "editable": false,
    "type": "string"
  },
  {
    "namespace": "crypto_wallet",
    "key": "fixed_sol_address",
    "label": "Solana收款地址",
    "group": "收款",
    "editable": false,
    "type": "string"
  },
  {
    "namespace": "sms",
    "key": "access_key_id",
    "label": "短信访问标识",
    "group": "短信",
    "editable": false,
    "type": "credential"
  },
  {
    "namespace": "sms",
    "key": "access_key_secret",
    "label": "短信访问密钥",
    "group": "短信",
    "editable": false,
    "type": "credential"
  },
  {
    "namespace": "sms",
    "key": "sign_name",
    "label": "短信签名",
    "group": "短信",
    "editable": false,
    "type": "string"
  },
  {
    "namespace": "sms",
    "key": "template_code",
    "label": "通用短信模板",
    "group": "短信",
    "editable": false,
    "type": "string"
  },
  {
    "namespace": "sms",
    "key": "template_code_login",
    "label": "登录短信模板",
    "group": "短信",
    "editable": false,
    "type": "string"
  },
  {
    "namespace": "sms",
    "key": "template_code_register",
    "label": "注册短信模板",
    "group": "短信",
    "editable": false,
    "type": "string"
  },
  {
    "namespace": "sms",
    "key": "template_code_reset",
    "label": "重置短信模板",
    "group": "短信",
    "editable": false,
    "type": "string"
  },
  {
    "namespace": "sms",
    "key": "template_code_bind",
    "label": "绑定短信模板",
    "group": "短信",
    "editable": false,
    "type": "string"
  },
  {
    "namespace": "sms",
    "key": "template_code_membership_expiry",
    "label": "会员到期提醒模板",
    "group": "短信",
    "editable": false,
    "type": "string"
  },
  {
    "namespace": "sms",
    "key": "template_code_membership_expired",
    "label": "会员已到期模板",
    "group": "短信",
    "editable": false,
    "type": "string"
  },
  {
    "namespace": "sms",
    "key": "test_phone",
    "label": "测试手机号",
    "group": "短信",
    "editable": false,
    "type": "string"
  },
  {
    "namespace": "smtp",
    "key": "host",
    "label": "邮件服务器",
    "group": "邮件",
    "editable": false,
    "type": "string"
  },
  {
    "namespace": "smtp",
    "key": "user",
    "label": "邮件账户",
    "group": "邮件",
    "editable": false,
    "type": "string"
  },
  {
    "namespace": "smtp",
    "key": "from",
    "label": "发件地址",
    "group": "邮件",
    "editable": false,
    "type": "string"
  },
  {
    "namespace": "smtp",
    "key": "from_name",
    "label": "发件人名称",
    "group": "邮件",
    "editable": false,
    "type": "string"
  },
  {
    "namespace": "smtp",
    "key": "port",
    "label": "邮件端口",
    "group": "邮件",
    "editable": true,
    "type": "integer",
    "minimum": "1",
    "maximum": "65535"
  },
  {
    "namespace": "smtp",
    "key": "secure",
    "label": "邮件安全连接",
    "group": "邮件",
    "editable": true,
    "type": "boolean"
  },
  {
    "namespace": "smtp",
    "key": "pass",
    "label": "邮件密码",
    "group": "邮件",
    "editable": false,
    "type": "credential"
  },
  {
    "namespace": "qiniu",
    "key": "access_key",
    "label": "七牛访问标识",
    "group": "七牛存储",
    "editable": false,
    "type": "credential"
  },
  {
    "namespace": "qiniu",
    "key": "secret_key",
    "label": "七牛访问密钥",
    "group": "七牛存储",
    "editable": false,
    "type": "credential"
  },
  {
    "namespace": "qiniu",
    "key": "bucket",
    "label": "七牛空间",
    "group": "七牛存储",
    "editable": false,
    "type": "string"
  },
  {
    "namespace": "qiniu",
    "key": "domain",
    "label": "七牛域名",
    "group": "七牛存储",
    "editable": false,
    "type": "string"
  },
  {
    "namespace": "qiniu",
    "key": "region",
    "label": "七牛区域",
    "group": "七牛存储",
    "editable": false,
    "type": "enum",
    "values": [
      "z0",
      "z1",
      "z2",
      "na0",
      "as0",
      "cn-east",
      "cn-south"
    ]
  },
  {
    "namespace": "qiniu",
    "key": "private_bucket",
    "label": "七牛私有空间",
    "group": "七牛存储",
    "editable": false,
    "type": "boolean"
  },
  {
    "namespace": "media_storage",
    "key": "default_provider",
    "label": "默认存储",
    "group": "媒体存储",
    "editable": false,
    "type": "enum",
    "values": [
      "local",
      "qiniu"
    ]
  },
  {
    "namespace": "media_storage",
    "key": "video_provider",
    "label": "视频存储",
    "group": "媒体存储",
    "editable": false,
    "type": "enum",
    "values": [
      "inherit",
      "local",
      "qiniu"
    ]
  },
  {
    "namespace": "media_storage",
    "key": "attachment_provider",
    "label": "附件存储",
    "group": "媒体存储",
    "editable": false,
    "type": "enum",
    "values": [
      "inherit",
      "local",
      "qiniu"
    ]
  },
  {
    "namespace": "media_storage",
    "key": "image_provider",
    "label": "图片存储",
    "group": "媒体存储",
    "editable": false,
    "type": "enum",
    "values": [
      "inherit",
      "local",
      "qiniu"
    ]
  },
  {
    "namespace": "media_storage",
    "key": "resource_provider",
    "label": "资源存储",
    "group": "媒体存储",
    "editable": false,
    "type": "enum",
    "values": [
      "inherit",
      "local",
      "qiniu"
    ]
  },
  {
    "namespace": "media_storage",
    "key": "local_root",
    "label": "本地存储目录",
    "group": "媒体存储",
    "editable": false,
    "type": "string"
  },
  {
    "namespace": "media_storage",
    "key": "qiniu_connection_test_version",
    "label": "七牛检测版本",
    "group": "媒体存储",
    "editable": false,
    "type": "string"
  },
  {
    "namespace": "media_storage",
    "key": "qiniu_connection_test_status",
    "label": "七牛检测状态",
    "group": "媒体存储",
    "editable": false,
    "type": "string"
  },
  {
    "namespace": "media_storage",
    "key": "qiniu_connection_test_stage",
    "label": "七牛检测阶段",
    "group": "媒体存储",
    "editable": false,
    "type": "string"
  },
  {
    "namespace": "media_storage",
    "key": "qiniu_connection_tested_at",
    "label": "七牛检测时间",
    "group": "媒体存储",
    "editable": false,
    "type": "string"
  },
  {
    "namespace": "media_storage",
    "key": "qiniu_connection_test_error",
    "label": "七牛检测错误",
    "group": "媒体存储",
    "editable": false,
    "type": "string"
  },
  {
    "namespace": "media_storage",
    "key": "qiniu_connection_test_cleanup_pending",
    "label": "七牛检测待清理",
    "group": "媒体存储",
    "editable": false,
    "type": "boolean"
  },
  {
    "namespace": "market_menu",
    "key": "items",
    "label": "行情菜单",
    "group": "行情菜单",
    "editable": false,
    "type": "json_array"
  },
  {
    "namespace": "toolbox",
    "key": "items",
    "label": "工具箱菜单",
    "group": "工具箱",
    "editable": false,
    "type": "json_array"
  },
  {
    "namespace": "changelog",
    "key": "version",
    "label": "更新版本",
    "group": "更新说明",
    "editable": true,
    "type": "integer",
    "minimum": "1",
    "maximum": "2147483647"
  },
  {
    "namespace": "changelog",
    "key": "content",
    "label": "更新说明",
    "group": "更新说明",
    "editable": false,
    "type": "string"
  }
]
