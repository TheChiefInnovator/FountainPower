module.exports = {
  apps: [
    {
      name: "fountainstack-power",
      cwd: "/Volumes/miles/Developer/FountainStack/Power",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3040",
      env: {
        NODE_ENV: "production",
        PORT: "3040",
      },
    },
  ],
};
