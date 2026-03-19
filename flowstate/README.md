# FlowState – AI Accountability Partner for ADHD Freelancers

FlowState is a web application designed to help ADHD freelancers maintain focus through personalized SMS check-ins and structured focus sessions.

## 🚀 Getting Started

To run the application locally, you need two terminals open: one for the **Backend (API)** and one for the **Frontend (UI)**.

### Prerequisites

- **Node.js**: v14+ (v18 recommended)
- **PostgreSQL**: Running locally on port `5432` with a database named `flowstate`.

---

### Step 1: Start the Backend Server

1.  Open a terminal in the `/backend` directory.
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Ensure your `.env` file is configured (Postgres, Gemini, Twilio keys).
4.  Start the development server:
    ```bash
    npm run dev
    ```
    The backend will run at **http://localhost:3000**.

---

### Step 2: Start the Frontend UI

1.  Open a new terminal in the `/frontend` directory.
2.  Start a local web server (using `serve` or any similar tool):
    ```bash
    npx serve -p 5500
    ```
    The frontend will run at **http://localhost:5500**.

---

### Step 3: Access the App

Open your browser and navigate to:
👉 **[http://localhost:5500](http://localhost:5500)**

---

## 🛠️ Tech Stack

- **Frontend**: HTML5, Vanilla CSS3 (Custom Design System), JavaScript.
- **Backend**: Node.js, Express.js.
- **Database**: PostgreSQL.
- **AI**: Google Gemini Pro.
- **SMS**: Twilio API.
