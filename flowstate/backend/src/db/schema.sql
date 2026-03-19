-- FlowState Database Schema
-- Run this script to initialize the database

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE,
  password_hash VARCHAR(255),
  phone_number VARCHAR(20) UNIQUE,
  timezone VARCHAR(100) NOT NULL DEFAULT 'America/New_York',
  work_type VARCHAR(255),
  stuck_points TEXT[] DEFAULT '{}',
  checkin_frequency VARCHAR(20) DEFAULT '15', -- '5', '15', '30', 'manual'
  tone_preference VARCHAR(50) DEFAULT 'coach', -- 'cheerleader', 'coach', 'gentle'
  calendar_connected BOOLEAN DEFAULT FALSE,
  tasks_connected BOOLEAN DEFAULT FALSE,
  tasks_provider VARCHAR(50), -- 'todoist', 'asana', 'notion'
  google_refresh_token TEXT,
  todoist_token TEXT,
  onboarded BOOLEAN DEFAULT FALSE,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  goal TEXT NOT NULL,
  scheduled_time TIMESTAMP WITH TIME ZONE NOT NULL,
  status VARCHAR(20) DEFAULT 'scheduled', -- 'scheduled', 'active', 'completed', 'missed', 'cancelled'
  actual_start_time TIMESTAMP WITH TIME ZONE,
  actual_end_time TIMESTAMP WITH TIME ZONE,
  accomplishments TEXT,
  user_rating INTEGER CHECK (user_rating >= 1 AND user_rating <= 5),
  duration_minutes INTEGER DEFAULT 60,
  next_checkin_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  direction VARCHAR(10) NOT NULL, -- 'incoming', 'outgoing'
  content TEXT NOT NULL,
  message_type VARCHAR(50) DEFAULT 'general',
  -- 'morning_checkin', 'session_start', 'checkin', 'response',
  -- 'reminder', 'celebration', 'missed', 'weekly_recap', 'onboarding'
  twilio_sid VARCHAR(100),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- User Preferences table
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  morning_checkin_time TIME DEFAULT '09:00:00',
  preferred_session_times TEXT[] DEFAULT '{}',
  quiet_hours_start TIME,
  quiet_hours_end TIME,
  reminder_lead_time_minutes INTEGER DEFAULT 15,
  weekly_recap_enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Conversation State table (tracks what "stage" the conversation is in)
CREATE TABLE IF NOT EXISTS conversation_state (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stage VARCHAR(100) DEFAULT 'idle',
  -- 'idle', 'awaiting_goal', 'awaiting_time', 'session_check',
  -- 'awaiting_accomplishments', 'awaiting_reschedule', 'onboarding_*'
  context JSONB DEFAULT '{}',
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_scheduled_time ON sessions(scheduled_time);
CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

-- Trigger to update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE OR REPLACE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER update_sessions_updated_at
  BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER update_user_preferences_updated_at
  BEFORE UPDATE ON user_preferences
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER update_conversation_state_updated_at
  BEFORE UPDATE ON conversation_state
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
