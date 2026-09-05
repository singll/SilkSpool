#!/usr/bin/env bash
# 串行轮询双项目 CT（单实例防 certspotter 限流；间隔在脚本内 delay 控制）
# 2026-09-05 从 csai 远程收编进仓库真相源（此前只存在于 /opt/silkspool/dsh/scripts/pipeline/，
# 未入 manifest templates——尚待接线：manifest.yaml templates 列表 + sec-suite-plugin-setup.sh
# install_scripts 归位循环，接线前 bundle setup 不会下发此文件）
while true; do
  /opt/silkspool/dsh/venv/bin/python /opt/silkspool/dsh/scripts/pipeline/ct-watch.py bytedance douyin.com,ixigua.com,trae.cn,coze.cn,bytedance.com,toutiao.com,oceanengine.com,jinritemai.com,volcpartner.com,volcengine.com,open-douyin.com,feishu.cn,jianying.com,volces.com,byteplus.com,snssdk.com,zijieapi.com,trae.com.cn,mchost.guru --once --delay 5
  sleep 30
  /opt/silkspool/dsh/venv/bin/python /opt/silkspool/dsh/scripts/pipeline/ct-watch.py meituan-src meituan.com,meituan.net,dianping.com,mykeeta.com,neixin.cn,zservey.com,maoyan.com,qiandai.com,mobike.com,keeta.com --once --delay 5
  sleep 1800
done
