<script setup lang="ts"></script>

<template>
  <div class="app">
    <router-view class="app-main" />
    <van-tabbar route>
      <van-tabbar-item to="/" icon="wap-home-o">首页</van-tabbar-item>
      <van-tabbar-item to="/screen" icon="search">选基</van-tabbar-item>
      <van-tabbar-item to="/watch" icon="star-o">自选</van-tabbar-item>
      <van-tabbar-item to="/compare" icon="exchange">对比</van-tabbar-item>
    </van-tabbar>
  </div>
</template>
