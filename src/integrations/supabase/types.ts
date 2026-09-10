export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      audit_logs: {
        Row: {
          action: string
          created_at: string
          entity: string | null
          entity_id: string | null
          id: string
          meta: Json | null
          tenant_id: string | null
          user_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          entity?: string | null
          entity_id?: string | null
          id?: string
          meta?: Json | null
          tenant_id?: string | null
          user_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          entity?: string | null
          entity_id?: string | null
          id?: string
          meta?: Json | null
          tenant_id?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_cycles: {
        Row: {
          created_at: string
          cycle_key: string
          ends_at: string
          id: string
          starts_at: string
          status: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          cycle_key: string
          ends_at: string
          id?: string
          starts_at: string
          status?: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          cycle_key?: string
          ends_at?: string
          id?: string
          starts_at?: string
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_cycles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          address: string | null
          created_at: string
          id: string
          name: string
          pay_account: string | null
          phone: string | null
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          address?: string | null
          created_at?: string
          id?: string
          name: string
          pay_account?: string | null
          phone?: string | null
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          address?: string | null
          created_at?: string
          id?: string
          name?: string
          pay_account?: string | null
          phone?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      meter_profiles: {
        Row: {
          color_semantics: Json
          created_at: string
          decimal_digits: number
          display_type: string
          id: string
          integer_digits: number
          name: string
          register_order: string
          tenant_id: string
          unit: string
          updated_at: string
        }
        Insert: {
          color_semantics?: Json
          created_at?: string
          decimal_digits?: number
          display_type: string
          id?: string
          integer_digits?: number
          name: string
          register_order?: string
          tenant_id: string
          unit?: string
          updated_at?: string
        }
        Update: {
          color_semantics?: Json
          created_at?: string
          decimal_digits?: number
          display_type?: string
          id?: string
          integer_digits?: number
          name?: string
          register_order?: string
          tenant_id?: string
          unit?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "meter_profiles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      meters: {
        Row: {
          created_at: string
          customer_id: string
          id: string
          installed_at: string | null
          profile_id: string | null
          serial_number: string
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          customer_id: string
          id?: string
          installed_at?: string | null
          profile_id?: string | null
          serial_number: string
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          customer_id?: string
          id?: string
          installed_at?: string | null
          profile_id?: string | null
          serial_number?: string
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "meters_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meters_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "meter_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meters_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount: number
          bill_id: string
          client_id: string | null
          collector_id: string | null
          created_at: string
          id: string
          method: string
          status: string
          tenant_id: string
        }
        Insert: {
          amount: number
          bill_id: string
          client_id?: string | null
          collector_id?: string | null
          created_at?: string
          id?: string
          method?: string
          status?: string
          tenant_id: string
        }
        Update: {
          amount?: number
          bill_id?: string
          client_id?: string | null
          collector_id?: string | null
          created_at?: string
          id?: string
          method?: string
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_bill_id_fkey"
            columns: ["bill_id"]
            isOneToOne: false
            referencedRelation: "water_bills"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          phone: string | null
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id: string
          phone?: string | null
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          phone?: string | null
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenants: {
        Row: {
          created_at: string
          id: string
          name: string
          project_name: string | null
          subscription_expires_at: string | null
          subscription_status: Database["public"]["Enums"]["subscription_status"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          project_name?: string | null
          subscription_expires_at?: string | null
          subscription_status?: Database["public"]["Enums"]["subscription_status"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          project_name?: string | null
          subscription_expires_at?: string | null
          subscription_status?: Database["public"]["Enums"]["subscription_status"]
          updated_at?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          tenant_id: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          tenant_id?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          tenant_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_roles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      water_bills: {
        Row: {
          arrears: number
          client_id: string | null
          created_at: string
          customer_id: string
          cycle_id: string | null
          id: string
          issued_at: string
          project_name: string | null
          reading_id: string | null
          status: string
          subtotal: number
          tenant_id: string
          total: number
        }
        Insert: {
          arrears?: number
          client_id?: string | null
          created_at?: string
          customer_id: string
          cycle_id?: string | null
          id?: string
          issued_at?: string
          project_name?: string | null
          reading_id?: string | null
          status?: string
          subtotal?: number
          tenant_id: string
          total?: number
        }
        Update: {
          arrears?: number
          client_id?: string | null
          created_at?: string
          customer_id?: string
          cycle_id?: string | null
          id?: string
          issued_at?: string
          project_name?: string | null
          reading_id?: string | null
          status?: string
          subtotal?: number
          tenant_id?: string
          total?: number
        }
        Relationships: [
          {
            foreignKeyName: "water_bills_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "water_bills_cycle_id_fkey"
            columns: ["cycle_id"]
            isOneToOne: false
            referencedRelation: "billing_cycles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "water_bills_reading_id_fkey"
            columns: ["reading_id"]
            isOneToOne: false
            referencedRelation: "water_readings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "water_bills_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      water_readings: {
        Row: {
          capture_source: string
          client_id: string | null
          consumption: number
          created_at: string
          current_reading: number
          customer_id: string | null
          flag: string
          id: string
          identity_verified: boolean
          lat: number | null
          lng: number | null
          meter_id: string | null
          meter_number: string
          ocr_confidence: number | null
          ocr_raw_text: string | null
          photo_url: string | null
          previous: number
          reader_id: string | null
          reading_verified: boolean
          review_reason: string | null
          source_device: string | null
          status: string
          tenant_id: string
        }
        Insert: {
          capture_source?: string
          client_id?: string | null
          consumption?: number
          created_at?: string
          current_reading: number
          customer_id?: string | null
          flag?: string
          id?: string
          identity_verified?: boolean
          lat?: number | null
          lng?: number | null
          meter_id?: string | null
          meter_number: string
          ocr_confidence?: number | null
          ocr_raw_text?: string | null
          photo_url?: string | null
          previous?: number
          reader_id?: string | null
          reading_verified?: boolean
          review_reason?: string | null
          source_device?: string | null
          status?: string
          tenant_id: string
        }
        Update: {
          capture_source?: string
          client_id?: string | null
          consumption?: number
          created_at?: string
          current_reading?: number
          customer_id?: string | null
          flag?: string
          id?: string
          identity_verified?: boolean
          lat?: number | null
          lng?: number | null
          meter_id?: string | null
          meter_number?: string
          ocr_confidence?: number | null
          ocr_raw_text?: string | null
          photo_url?: string | null
          previous?: number
          reader_id?: string | null
          reading_verified?: boolean
          review_reason?: string | null
          source_device?: string | null
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "water_readings_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "water_readings_meter_id_fkey"
            columns: ["meter_id"]
            isOneToOne: false
            referencedRelation: "meters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "water_readings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      activate_tenant: {
        Args: {
          _days?: number
          _license_key: string
          _max_seats: number
          _tenant_id: string
        }
        Returns: {
          created_at: string
          id: string
          name: string
          project_name: string | null
          subscription_expires_at: string | null
          subscription_status: Database["public"]["Enums"]["subscription_status"]
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "tenants"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      current_billing_cycle: {
        Args: { p_at?: string; p_tenant: string }
        Returns: string
      }
      current_tenant_id: { Args: never; Returns: string }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      has_tenant_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _tenant_id: string
        }
        Returns: boolean
      }
      is_super_admin: { Args: never; Returns: boolean }
      record_water_reading: {
        Args: {
          p_accuracy?: number
          p_capture_source?: string
          p_client_id?: string
          p_current: number
          p_lat?: number
          p_lng?: number
          p_meter_id: string
          p_ocr_confidence?: number
          p_ocr_raw_text?: string
          p_ocr_serial?: string
          p_photo_url?: string
        }
        Returns: {
          arrears: number
          bill_id: string
          bill_total: number
          consumption: number
          current_reading: number
          previous: number
          project_name: string
          reading_id: string
        }[]
      }
      water_charge: { Args: { p_units: number }; Returns: number }
    }
    Enums: {
      app_role: "super_admin" | "manager" | "reader" | "collector"
      subscription_status: "active" | "suspended" | "expired"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["super_admin", "manager", "reader", "collector"],
      subscription_status: ["active", "suspended", "expired"],
    },
  },
} as const
