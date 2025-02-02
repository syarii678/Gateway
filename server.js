const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const path = require("path");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static("public"));

// Set view engine ke EJS
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Konfigurasi
const config = {
  // Konfigurasi SimpleBot API untuk pembayaran
  apiSimpleBot: "simplebotz85",
  qrisOrderKuota: "00020101021126670016COM.NOBUBANK.WWW01189360050300000879140214158128780887670303UMI51440014ID.CO.QRIS.WWW0215ID20222313124650303UMI5204481253033605802ID5911XZYYO STORE6007BOALEMO61059626562070703A016304A904", // lengkapi sesuai konfigurasi Anda
  merchantIdOrderKuota: "OK857325",
  apiOrderKuota: "27332081734516354857325OKCT83D1D41E52AC9B58EC52B4B6A9BE4F10",
  botname: "xzyyo",

  // Konfigurasi Pterodactyl Panel
  pteroDomain: "https://panel-private.xyz",
  pteroApiKey: "ptla_CEOE25G0yswKQnkbO4wiPdhaiCzgW3SgoZRbG96L0bM",
  nestId: "5",
  eggId: "15",
  location: "1",
};

let transactions = {};

// Fungsi helper untuk format rupiah (IDR)
function toIDR(number) {
  return number.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

// Mendapatkan spesifikasi panel berdasarkan opsi pembelian
function getPanelSpec(option) {
  const specs = {
    "1gb": { memory: 1000, swap: 0, io: 500, disk: 1000, cpu: 40, harga: 100 },
    "2gb": { memory: 2000, swap: 0, io: 500, disk: 1000, cpu: 60, harga: 2000 },
    "unlimited": { memory: 0, swap: 0, io: 0, disk: 0, cpu: 0, harga: 11000 },
  };
  return specs[option.toLowerCase()] || null;
}

// Fungsi untuk melakukan request ke API Pterodactyl
async function pteroRequest(method, endpoint, data = null) {
  try {
    const response = await axios({
      method,
      url: `${config.pteroDomain}${endpoint}`,
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.pteroApiKey}`,
      },
      data: data ? JSON.stringify(data) : null,
    });
    return response.data;
  } catch (error) {
    console.error("Pterodactyl API Error:", error.response ? error.response.data : error.message);
    throw error;
  }
}

// Halaman utama (menampilkan pilihan panel)
app.get("/", (req, res) => {
  const panelOptions = [
    { title: "Ram Unlimited", harga: "Rp11.000", value: "unlimited" },
    { title: "Ram 1GB", harga: "Rp100", value: "1gb" },
    { title: "Ram 2GB", harga: "Rp2.000", value: "2gb" },
  ];
  res.render("index", { botname: config.botname, panelOptions });
});

// Proses pembelian: membuat request pembayaran via SimpleBot API
app.post("/purchase", async (req, res) => {
  const option = req.body.option;
  const spec = getPanelSpec(option);
  if (!spec) return res.send("Invalid option!");

  // Tambahkan extra fee acak (misalnya antara 110 dan 250)
  const randomExtra = Math.floor(Math.random() * (250 - 110 + 1)) + 110;
  const amount = spec.harga + randomExtra;

  try {
    const response = await axios.get(`https://api.simplebot.my.id/api/orkut/createpayment`, {
      params: {
        apikey: config.apiSimpleBot,
        amount: amount,
        codeqr: config.qrisOrderKuota,
      },
    });

    const result = response.data.result;
    // Simpan transaksi sementara di memori
    transactions[result.transactionId] = {
      spec,
      amount: result.amount,
      qrImageUrl: result.qrImageUrl,
      createdAt: Date.now(),
      status: "pending",
    };

    res.render("payment", {
      botname: config.botname,
      transactionId: result.transactionId,
      amount: toIDR(result.amount),
      qrImageUrl: result.qrImageUrl,
      expireMinutes: 5,
    });
  } catch (error) {
    console.error("Payment creation error:", error);
    res.send("Payment creation failed.");
  }
});

// Cek status pembayaran dan, jika sudah lunas, buat server panel otomatis
app.get("/check-payment", async (req, res) => {
  const txId = req.query.txId;
  const transaction = transactions[txId];
  if (!transaction)
    return res.json({ status: "error", message: "Transaction not found" });

  try {
    const cekResponse = await axios.get(`https://api.simplebot.my.id/api/orkut/cekstatus`, {
      params: {
        apikey: config.apiSimpleBot,
        merchant: config.merchantIdOrderKuota,
        keyorkut: config.apiOrderKuota,
      },
    });

    // Jika jumlah pembayaran sesuai, maka transaksi dianggap lunas
    if (cekResponse.data?.amount === transaction.amount) {
      if (transaction.status !== "paid") {
        transaction.status = "paid";

        // Buat user di panel Pterodactyl
        const username = crypto.randomBytes(4).toString("hex");
        const email = `${username}@gmail.com`;
        const name = username.toUpperCase();
        const password = username + crypto.randomBytes(2).toString("hex");

        let user;
        try {
          user = await pteroRequest("POST", "/api/application/users", {
            email: email,
            username: username,
            first_name: name,
            last_name: "User",
            language: "en",
            password: password,
          });
        } catch (userError) {
          console.error("User creation error:", userError);
          return res.json({ status: "error", message: "User creation failed." });
        }

        // Buat server di panel Pterodactyl dengan mengirim field yang diperlukan
        let server;
        try {
          server = await pteroRequest("POST", "/api/application/servers", {
            name: name,
            user: user.attributes.id,
            egg: parseInt(config.eggId),
            nest: parseInt(config.nestId),
            docker_image: "ghcr.io/parkervcp/yolks:nodejs_18",
            startup: "npm start", // Field startup wajib
            // Pastikan variabel environment sesuai dengan yang diharapkan egg.
            environment: {
              CMD_RUN: "npm start"  // Menambahkan variabel 'CMD_RUN' sebagai field Command Run
            },
            limits: {
              memory: transaction.spec.memory,
              swap: transaction.spec.swap,
              io: transaction.spec.io,
              disk: transaction.spec.disk,
              cpu: transaction.spec.cpu,
            },
            feature_limits: {
              databases: 1,
              backups: 1,
              allocations: 1,
            },
            deploy: {
              locations: [parseInt(config.location)],
              dedicated_ip: false,
              port_range: [],
            },
          });
        } catch (serverError) {
          console.error("Server creation error:", serverError);
          return res.json({ status: "error", message: "Server creation failed." });
        }

        // Simpan data server beserta kredensial user
        transaction.server = {
          ...server.attributes,
          credentials: { username, password, email },
        };
      }
      // Redirect ke halaman success setelah pembayaran lunas dan server dibuat
      return res.json({ status: "paid", redirectUrl: `/success/${txId}` });
    }
    return res.json({ status: "pending" });
  } catch (error) {
    console.error("Payment check error:", error);
    return res.json({ status: "error", message: "Payment check failed." });
  }
});

// Halaman sukses: tampilkan data panel (nama server, username, password, dan domain)
app.get("/success/:txId", (req, res) => {
  const txId = req.params.txId;
  const transaction = transactions[txId];
  if (!transaction || transaction.status !== "paid") return res.redirect("/");

  res.render("success", {
    botname: config.botname,
    server: transaction.server,
    domain: config.pteroDomain, // domain panel yang digunakan
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
