export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      aliases: {
        Row: {
          alias_type: string | null
          approved: boolean
          business_id: string
          clean_code: string
          created_at: string
          id: string
          idempotency_key: string | null
          normalized_code: string | null
          product_id: string
          raw_code_example: string | null
        }
        Insert: {
          alias_type?: string | null
          approved?: boolean
          business_id: string
          clean_code: string
          created_at?: string
          id?: string
          idempotency_key?: string | null
          normalized_code?: string | null
          product_id: string
          raw_code_example?: string | null
        }
        Update: {
          alias_type?: string | null
          approved?: boolean
          business_id?: string
          clean_code?: string
          created_at?: string
          id?: string
          idempotency_key?: string | null
          normalized_code?: string | null
          product_id?: string
          raw_code_example?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "aliases_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "aliases_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          business_id: string
          created_at: string
          detail: Json | null
          entity_id: string | null
          entity_type: string | null
          id: string
          user_id: string | null
        }
        Insert: {
          action: string
          business_id: string
          created_at?: string
          detail?: Json | null
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          user_id?: string | null
        }
        Update: {
          action?: string
          business_id?: string
          created_at?: string
          detail?: Json | null
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      businesses: {
        Row: {
          created_at: string
          created_by: string
          id: string
          name: string
        }
        Insert: {
          created_at?: string
          created_by: string
          id?: string
          name: string
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      catalog_entries: {
        Row: {
          brand: string | null
          category: string | null
          created_at: string
          evidence: Json | null
          first_seen_at: string
          id: string
          image_url: string | null
          last_seen_at: string | null
          last_verified_at: string | null
          name: string | null
          normalized_barcode: string
          source_urls: string[]
          times_confirmed: number
          times_scanned: number
          verification_status: string
        }
        Insert: {
          brand?: string | null
          category?: string | null
          created_at?: string
          evidence?: Json | null
          first_seen_at?: string
          id?: string
          image_url?: string | null
          last_seen_at?: string | null
          last_verified_at?: string | null
          name?: string | null
          normalized_barcode: string
          source_urls?: string[]
          times_confirmed?: number
          times_scanned?: number
          verification_status?: string
        }
        Update: {
          brand?: string | null
          category?: string | null
          created_at?: string
          evidence?: Json | null
          first_seen_at?: string
          id?: string
          image_url?: string | null
          last_seen_at?: string | null
          last_verified_at?: string | null
          name?: string | null
          normalized_barcode?: string
          source_urls?: string[]
          times_confirmed?: number
          times_scanned?: number
          verification_status?: string
        }
        Relationships: []
      }
      inventory_counts: {
        Row: {
          applied_idempotency_keys: string[]
          business_id: string
          id: string
          product_id: string
          quantity: number
          scan_event_ids: string[]
          session_id: string
          updated_at: string
        }
        Insert: {
          applied_idempotency_keys?: string[]
          business_id: string
          id?: string
          product_id: string
          quantity?: number
          scan_event_ids?: string[]
          session_id: string
          updated_at?: string
        }
        Update: {
          applied_idempotency_keys?: string[]
          business_id?: string
          id?: string
          product_id?: string
          quantity?: number
          scan_event_ids?: string[]
          session_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_counts_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_counts_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_counts_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "inventory_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_sessions: {
        Row: {
          business_id: string
          completed_at: string | null
          created_by: string | null
          id: string
          location: string | null
          name: string | null
          started_at: string
          status: string
        }
        Insert: {
          business_id: string
          completed_at?: string | null
          created_by?: string | null
          id?: string
          location?: string | null
          name?: string | null
          started_at?: string
          status?: string
        }
        Update: {
          business_id?: string
          completed_at?: string | null
          created_by?: string | null
          id?: string
          location?: string | null
          name?: string | null
          started_at?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_sessions_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      memberships: {
        Row: {
          business_id: string
          created_at: string
          id: string
          role: string
          user_id: string
        }
        Insert: {
          business_id: string
          created_at?: string
          id?: string
          role: string
          user_id: string
        }
        Update: {
          business_id?: string
          created_at?: string
          id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "memberships_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          brand: string | null
          business_id: string
          category: string | null
          created_at: string
          ean: string | null
          gtin: string | null
          id: string
          name: string
          primary_barcode: string | null
          primary_sku: string | null
          source: string | null
          upc: string | null
          updated_at: string
          vendor_codes: string[]
          verified: boolean
        }
        Insert: {
          brand?: string | null
          business_id: string
          category?: string | null
          created_at?: string
          ean?: string | null
          gtin?: string | null
          id?: string
          name: string
          primary_barcode?: string | null
          primary_sku?: string | null
          source?: string | null
          upc?: string | null
          updated_at?: string
          vendor_codes?: string[]
          verified?: boolean
        }
        Update: {
          brand?: string | null
          business_id?: string
          category?: string | null
          created_at?: string
          ean?: string | null
          gtin?: string | null
          id?: string
          name?: string
          primary_barcode?: string | null
          primary_sku?: string | null
          source?: string | null
          upc?: string | null
          updated_at?: string
          vendor_codes?: string[]
          verified?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "products_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      scan_events: {
        Row: {
          business_id: string
          clean_code: string | null
          created_at: string
          id: string
          idempotency_key: string | null
          match_type: string | null
          quantity_delta: number
          raw_code: string | null
          resolver_status: string | null
          session_id: string | null
          status: string | null
        }
        Insert: {
          business_id: string
          clean_code?: string | null
          created_at?: string
          id?: string
          idempotency_key?: string | null
          match_type?: string | null
          quantity_delta?: number
          raw_code?: string | null
          resolver_status?: string | null
          session_id?: string | null
          status?: string | null
        }
        Update: {
          business_id?: string
          clean_code?: string | null
          created_at?: string
          id?: string
          idempotency_key?: string | null
          match_type?: string | null
          quantity_delta?: number
          raw_code?: string | null
          resolver_status?: string | null
          session_id?: string | null
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "scan_events_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scan_events_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "inventory_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      settings: {
        Row: {
          ai_lookup_enabled: boolean
          business_id: string
          data: Json
          primary_provider: string | null
          updated_at: string
        }
        Insert: {
          ai_lookup_enabled?: boolean
          business_id: string
          data?: Json
          primary_provider?: string | null
          updated_at?: string
        }
        Update: {
          ai_lookup_enabled?: boolean
          business_id?: string
          data?: Json
          primary_provider?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "settings_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: true
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      shop_overrides: {
        Row: {
          brand: string | null
          business_id: string
          category: string | null
          created_at: string
          id: string
          name: string | null
          normalized_barcode: string
        }
        Insert: {
          brand?: string | null
          business_id: string
          category?: string | null
          created_at?: string
          id?: string
          name?: string | null
          normalized_barcode: string
        }
        Update: {
          brand?: string | null
          business_id?: string
          category?: string | null
          created_at?: string
          id?: string
          name?: string | null
          normalized_barcode?: string
        }
        Relationships: [
          {
            foreignKeyName: "shop_overrides_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      unknown_code_reviews: {
        Row: {
          business_id: string
          clean_code: string | null
          created_at: string
          decode_status: string | null
          id: string
          idempotency_key: string | null
          raw_code: string | null
          resolution_action: string | null
          session_id: string | null
          status: string
          suggested: Json
        }
        Insert: {
          business_id: string
          clean_code?: string | null
          created_at?: string
          decode_status?: string | null
          id?: string
          idempotency_key?: string | null
          raw_code?: string | null
          resolution_action?: string | null
          session_id?: string | null
          status?: string
          suggested?: Json
        }
        Update: {
          business_id?: string
          clean_code?: string | null
          created_at?: string
          decode_status?: string | null
          id?: string
          idempotency_key?: string | null
          raw_code?: string | null
          resolution_action?: string | null
          session_id?: string | null
          status?: string
          suggested?: Json
        }
        Relationships: [
          {
            foreignKeyName: "unknown_code_reviews_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "unknown_code_reviews_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "inventory_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      create_business: { Args: { p_name: string }; Returns: string }
      has_role: { Args: { b: string; r: string }; Returns: boolean }
      is_member: { Args: { b: string }; Returns: boolean }
    }
    Enums: {
      [_ in never]: never
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

