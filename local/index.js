const express = require("express");

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
    res.send("Local downloader is running");
});

app.listen(4000, () => {
    console.log("✅ Local server running on http://localhost:4000");
});
