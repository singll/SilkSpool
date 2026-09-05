#!/usr/bin/env bash
# 串行轮询双项目 CT（单实例防 certspotter 限流；间隔在脚本内 delay 控制）
# 2026-09-05 从 csai 远程收编进仓库真相源（此前只存在于 /opt/silkspool/dsh/scripts/pipeline/）
# v4.6 已接线：manifest templates + sec-suite-plugin-setup.sh install_scripts 归位 +
#   setup.sh §9.7 ct-watch.service 单元纳管（此前为手工单元，重部署会丢）
while true; do
  /opt/silkspool/dsh/venv/bin/python /opt/silkspool/dsh/scripts/pipeline/ct-watch.py bytedance douyin.com,ixigua.com,trae.cn,coze.cn,bytedance.com,toutiao.com,oceanengine.com,jinritemai.com,volcpartner.com,volcengine.com,open-douyin.com,feishu.cn,jianying.com,volces.com,byteplus.com,snssdk.com,zijieapi.com,trae.com.cn,mchost.guru --once --delay 5
  sleep 30
  /opt/silkspool/dsh/venv/bin/python /opt/silkspool/dsh/scripts/pipeline/ct-watch.py meituan-src meituan.com,meituan.net,dianping.com,mykeeta.com,neixin.cn,zservey.com,maoyan.com,qiandai.com,mobike.com,keeta.com --once --delay 5
  sleep 1800
done
