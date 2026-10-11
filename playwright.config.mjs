import {defineConfig} from '@playwright/test';
import chromium from '@sparticuz/chromium';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
mkdirSync('/workspace/.cache/fontconfig',{recursive:true});
writeFileSync('/tmp/restaurant-fonts.conf','<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><include ignore_missing="yes">/etc/fonts/fonts.conf</include><cachedir>/workspace/.cache/fontconfig</cachedir></fontconfig>');
process.env.E2E_DATA_DIR ||= mkdtempSync('/tmp/restaurant-e2e-');
export default defineConfig({
  testDir:'./tests/browser',timeout:30000,fullyParallel:false,workers:1,
  reporter:'list',
  use:{baseURL:'http://127.0.0.1:3002',viewport:{width:1440,height:1000},trace:'retain-on-failure',screenshot:'only-on-failure',launchOptions:{executablePath:await chromium.executablePath(),args:chromium.args.filter(a=>a!=='--single-process'),env:{...process.env,FONTCONFIG_FILE:'/tmp/restaurant-fonts.conf',XDG_CACHE_HOME:'/workspace/.cache'}}},
  webServer:{command:'node server/index.mjs',url:'http://127.0.0.1:3002/api/health',reuseExistingServer:false,env:{PORT:'3002',DATA_DIR:process.env.E2E_DATA_DIR,NODE_ENV:'development',DEMO_MODE:'true'},timeout:30000},
});
